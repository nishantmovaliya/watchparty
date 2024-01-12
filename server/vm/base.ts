import config from '../config';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { redis, redisCount } from '../utils/redis';
import { newPostgres } from '../utils/postgres';
import { PoolConfig, PoolRegion } from './utils';
const incrInterval = 5 * 1000;
const decrInterval = 30 * 1000;
const cleanupInterval = 5 * 60 * 1000;

const postgres = newPostgres();

export abstract class VMManager {
  protected isLarge = false;
  protected region: PoolRegion = 'US';
  private limitSize = 0;
  private minSize = 0;

  constructor({ isLarge, region, limitSize, minSize }: PoolConfig) {
    this.isLarge = isLarge;
    this.region = region;
    this.limitSize = Number(limitSize);
    this.minSize = Number(minSize);
  }

  public getIsLarge = () => {
    return this.isLarge;
  };

  public getRegion = () => {
    return this.region;
  };

  public getMinSize = () => {
    return this.minSize;
  };

  public getLimitSize = () => {
    return this.limitSize;
  };

  public getMinBuffer = () => {
    return this.limitSize * 0.05;
  };

  public getCurrentSize = async () => {
    const { rows } = await postgres.query(
      `SELECT count(1) FROM vbrowser WHERE pool = $1`,
      [this.getPoolName()]
    );
    return Number(rows[0]?.count);
  };

  public getPoolName = () => {
    return this.id + (this.isLarge ? 'Large' : '') + this.region;
  };

  public getAdjustedBuffer = () => {
    let minBuffer = this.getMinBuffer();
    // If ramping config, adjust minBuffer based on the hour
    // During ramp down hours, keep a smaller buffer
    // During ramp up hours, keep a larger buffer
    const rampDownHours = config.VM_POOL_RAMP_DOWN_HOURS.split(',').map(Number);
    const rampUpHours = config.VM_POOL_RAMP_UP_HOURS.split(',').map(Number);
    const nowHour = new Date().getUTCHours();
    const isRampDown =
      rampDownHours.length &&
      pointInInterval24(nowHour, rampDownHours[0], rampDownHours[1]);
    const isRampUp =
      rampUpHours.length &&
      pointInInterval24(nowHour, rampUpHours[0], rampUpHours[1]);
    if (isRampDown) {
      minBuffer /= 2;
    } else if (isRampUp) {
      minBuffer *= 1.5;
    }
    return [Math.ceil(minBuffer), Math.ceil(minBuffer * 1.5)];
  };

  public getAvailableCount = async (): Promise<number> => {
    const { rows } = await postgres.query(
      `SELECT count(1) FROM vbrowser WHERE pool = $1 and state = 'available'`,
      [this.getPoolName()]
    );
    return Number(rows[0]?.count);
  };

  public getStagingCount = async (): Promise<number> => {
    const { rows } = await postgres.query(
      `SELECT count(1) FROM vbrowser WHERE pool = $1 and state = 'staging'`,
      [this.getPoolName()]
    );
    return Number(rows[0]?.count);
  };

  public getAvailableVBrowsers = async (): Promise<string[]> => {
    const { rows } = await postgres.query(
      `SELECT vmid from vbrowser WHERE pool = $1 and state = 'available'`,
      [this.getPoolName()]
    );
    return rows.map((row: any) => row.vmid);
  };

  public getStagingVBrowsers = async (): Promise<string[]> => {
    const { rows } = await postgres.query(
      `SELECT vmid from vbrowser WHERE pool = $1 and state = 'staging'`,
      [this.getPoolName()]
    );
    return rows.map((row: any) => row.vmid);
  };

  public getTag = () => {
    return (
      (config.VBROWSER_TAG || 'vbrowser') +
      this.region +
      (this.isLarge ? 'Large' : '')
    );
  };

  public assignVM = async (
    roomId: string,
    uid: string
  ): Promise<AssignedVM | undefined> => {
    if (!roomId || !uid) {
      return undefined;
    }
    let postgres2 = newPostgres();
    await postgres2.query('BEGIN TRANSACTION');
    try {
      const assignStart = Number(new Date());
      if (this.getMinSize() === 0) {
        // Spawns a VM if none is available in the pool
        const availableCount = await this.getAvailableCount();
        if (!availableCount) {
          await this.startVMWrapper();
        }
      }
      // Update and use SKIP LOCKED to ensure each consumer only gets one
      const getAssignedVM = async (): Promise<VM | undefined> => {
        const { rows } = await postgres2.query(
          `
        UPDATE vbrowser 
        SET "roomId" = $1, uid = $2, "heartbeatTime" = $3, "assignTime" = $4, state = 'used'
        WHERE id = (
          SELECT id
          FROM vbrowser
          WHERE state = 'available'
          AND pool = $5
          ORDER BY id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING data`,
          [roomId, uid, new Date(), new Date(), this.getPoolName()]
        );
        return rows[0]?.data;
      };
      let selected: VM | undefined = undefined;
      while (!selected) {
        // make sure this room still wants a VM, otherwise rollback the transaction to avoid waste
        const inQueue = await postgres2.query(
          'SELECT "roomId" FROM vbrowser_queue WHERE "roomId" = $1 LIMIT 1',
          [roomId]
        );
        if (!Boolean(inQueue.rows.length)) {
          await postgres2.query('ROLLBACK');
          await postgres2.end();
          console.log('[ASSIGN] room %s no longer in queue', roomId);
          return undefined;
        }
        selected = await getAssignedVM();
        if (!selected) {
          // Wait and try again
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      const assignEnd = Number(new Date());
      const assignElapsed = assignEnd - assignStart;
      await redis?.lpush('vBrowserStartMS', assignElapsed);
      await redis?.ltrim('vBrowserStartMS', 0, 24);
      console.log(
        '[ASSIGN] %s to %s in %s',
        selected.id,
        roomId,
        assignElapsed + 'ms'
      );
      const retVal = { ...selected, assignTime: Number(new Date()) };
      await postgres2.query('COMMIT');
      await postgres2.end();
      return retVal;
    } catch (e) {
      console.warn(e);
      await postgres2.query('ROLLBACK');
      await postgres2.end();
      return undefined;
    }
  };

  public resetVM = async (vmid: string, uid?: string): Promise<void> => {
    if (uid !== undefined) {
      // verify the uid matches if user initiated
      const vmUid = await postgres.query(
        `SELECT uid FROM vbrowser WHERE pool = $1 AND vmid = $2`,
        [this.getPoolName(), vmid]
      );
      if (vmUid.rows[0]?.uid && vmUid.rows[0]?.uid !== uid) {
        console.log(
          '[RESET] uid mismatch on %s, expected %s, got %s',
          vmid,
          vmUid.rows[0]?.uid,
          uid
        );
        return;
      }
    }
    // We can attempt to reuse the instance which is more efficient if users tend to use them for a short time
    // Otherwise terminating them is simpler but more expensive since they're billed for an hour
    console.log('[RESET]', vmid);
    await this.rebootVM(vmid);
    const { rowCount } = await postgres.query(
      `
      UPDATE vbrowser
      SET "roomId" = NULL, uid = NULL, retries = 0, "heartbeatTime" = NULL, "resetTime" = $3, "readyTime" = NULL, "assignTime" = NULL, data = NULL, state = 'staging'
      WHERE pool = $1 AND vmid = $2`,
      [this.getPoolName(), vmid, new Date()]
    );
    console.log('UPDATE', rowCount);
    if (rowCount === 0) {
      // terminate if we don't have a record of it
      // This could happen while we're migrating and don't have records yet
      // Or if resetting a VM from cleanup that we didn't record in db
      // Or if Docker terminated the VM in reboot already since we don't reuse containers
      // Of if we resized down but didn't complete the termination
      // In the Docker case that leads to a double terminate but might be ok
      this.terminateVMWrapper(vmid);
    }
  };

  public startVMWrapper = async () => {
    // generate credentials and boot a VM
    try {
      const password = uuidv4();
      const id = await this.startVM(password);
      await postgres.query(
        `
      INSERT INTO vbrowser(pool, vmid, "creationTime", state) 
      VALUES($1, $2, $3, 'staging')`,
        [this.getPoolName(), id, new Date()]
      );
      redisCount('vBrowserLaunches');
      return id;
    } catch (e: any) {
      console.log(
        e.response?.status,
        JSON.stringify(e.response?.data),
        e.config?.url,
        e.config?.data
      );
    }
  };

  protected terminateVMWrapper = async (vmid: string) => {
    console.log('[TERMINATE]', vmid);
    await this.terminateVM(vmid);
    const { rowCount } = await postgres.query(
      `DELETE FROM vbrowser WHERE pool = $1 AND vmid = $2 RETURNING id`,
      [this.getPoolName(), vmid]
    );
    // We can log the VM lifetime here if desired
    console.log('DELETE', rowCount);
  };

  public runBackgroundJobs = async () => {
    const resizeVMGroupIncr = async () => {
      const availableCount = await this.getAvailableCount();
      const stagingCount = await this.getStagingCount();
      const currentSize = await this.getCurrentSize();
      let launch = false;
      launch =
        availableCount + stagingCount < this.getAdjustedBuffer()[0] &&
        currentSize < (this.getLimitSize() || Infinity);
      if (launch) {
        console.log(
          '[RESIZE-LAUNCH]',
          'minimum:',
          this.getAdjustedBuffer()[0],
          'available:',
          availableCount,
          'staging:',
          stagingCount,
          'currentSize:',
          currentSize,
          'limit:',
          this.getLimitSize()
        );
        this.startVMWrapper();
      }
    };

    const resizeVMGroupDecr = async () => {
      let unlaunch = false;
      const availableCount = await this.getAvailableCount();
      unlaunch = availableCount > this.getAdjustedBuffer()[1];
      if (unlaunch) {
        // use SKIP LOCKED to delete to avoid deleting VM that might be assigning
        // filter to only VMs eligible for deletion
        // they must be up for long enough
        // keep the oldest min pool size number of VMs
        const { rows } = await postgres.query(
          `
          DELETE FROM vbrowser
          WHERE id = (
            SELECT id
            FROM vbrowser
            WHERE pool = $1
            AND state = 'available'
            AND CAST(extract(epoch from now() - "creationTime") as INT) % (60 * 60) > $2
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            OFFSET $3
          ) RETURNING vmid, CAST(extract(epoch from now() - "creationTime") as INT) % (60 * 60) as uptime_frac`,
          [
            this.getPoolName(),
            config.VM_MIN_UPTIME_MINUTES * 60, // to seconds
            this.getMinSize(),
          ]
        );
        const first = rows[0];
        if (first) {
          console.log(
            '[RESIZE-UNLAUNCH] %s up for %s seconds of hour',
            first.vmid,
            first.uptime_frac
          );
          await this.terminateVMWrapper(first.vmid);
        }
      }
    };

    const cleanupVMGroup = async () => {
      // Clean up hanging VMs
      // It's possible we created a VM but lost track of it
      // Take the list of VMs from API
      // subtract VMs that have a heartbeat or are in the available or staging pool
      // delete the rest
      let allVMs = [];
      try {
        allVMs = await this.listVMs(this.getTag());
      } catch (e) {
        console.log('cleanupVMGroup: failed to fetch VM list');
        return;
      }
      const { rows } = await postgres.query(
        `
        SELECT vmid from vbrowser
        WHERE pool = $1
        AND
        ("heartbeatTime" > (NOW() - INTERVAL '5 minutes')
        OR state = 'staging'
        OR state = 'available')
        `,
        [this.getPoolName()]
      );
      const dontDelete = new Set(rows.map((row: any) => row.vmid));
      console.log(
        '[CLEANUP] %s: found %s VMs, %s to keep',
        this.getPoolName(),
        allVMs.length,
        dontDelete.size
      );
      for (let i = 0; i < allVMs.length; i++) {
        const server = allVMs[i];
        if (!dontDelete.has(server.id)) {
          console.log('[CLEANUP]', server.id);
          try {
            await this.resetVM(server.id);
            //this.terminateVMWrapper(server.id);
          } catch (e: any) {
            console.warn(e.response?.data);
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };

    const checkStaging = async () => {
      const staging = await postgres.query(
        `SELECT id FROM vbrowser WHERE pool = $1 and state = 'staging'`,
        [this.getPoolName()]
      );
      const stagingPromises = staging.rows.map((row: any) => {
        return new Promise<string>(async (resolve, reject) => {
          const rowid = row.id;
          // Increment retry count and return data
          const { rows } = await postgres.query(
            `
              UPDATE vbrowser
              SET retries = retries + 1 WHERE id = $1
              RETURNING vmid, data, retries
            `,
            [rowid]
          );
          const first = rows[0];
          if (!first) {
            return reject('row not found for id ' + rowid);
          }
          let vmid = first.vmid as string;
          let retryCount = first.retries as number;
          let vm = first.data as VM | null;
          if (retryCount < this.minRetries) {
            if (config.NODE_ENV === 'development') {
              console.log(
                '[CHECKSTAGING] attempt %s, waiting for minRetries',
                retryCount
              );
            }
            // Do a minimum # of retries to give reboot time
            return resolve(vmid + ', ' + retryCount + ', ' + false);
          }
          let ready = false;
          // Fetch data on first attempt
          // Try again only every once in a while to reduce load on cloud API
          const shouldFetchVM =
            retryCount === this.minRetries + 1 || retryCount % 20 === 0;
          if (!vm && shouldFetchVM) {
            try {
              vm = await this.getVM(vmid);
            } catch (e: any) {
              console.warn(e.response?.data);
              if (e.response?.status === 404) {
                // Remove the VM beecause the provider says it doesn't exist
                await postgres.query('DELETE FROM vbrowser WHERE id = $1', [
                  rowid,
                ]);
                return reject('failed to find vm ' + vmid);
              }
            }
            if (vm?.host) {
              // Save the VM data
              await postgres.query(
                `UPDATE vbrowser SET data = $1 WHERE id = $2`,
                [vm, rowid]
              );
            }
          }
          if (!vm?.host) {
            console.log('[CHECKSTAGING] no host for vm %s', vmid);
            return reject('no host for vm ' + vmid);
          }
          ready = await checkVMReady(vm.host);
          if (ready) {
            console.log('[CHECKSTAGING] ready:', vmid, vm?.host, retryCount);
            await postgres.query(
              `UPDATE vbrowser SET state = 'available', "readyTime" = $2 WHERE id = $1`,
              [rowid, new Date()]
            );
            await redis?.lpush('vBrowserStageRetries', retryCount);
            await redis?.ltrim('vBrowserStageRetries', 0, 24);
          } else {
            if (retryCount >= 240) {
              console.log('[CHECKSTAGING]', 'giving up:', vmid);
              redisCount('vBrowserStagingFails');
              await redis?.lpush('vBrowserStageFails', vmid);
              await redis?.ltrim('vBrowserStageFails', 0, 24);
              await this.resetVM(vmid);
              // await this.terminateVMWrapper(id);
            } else {
              if (retryCount % 150 === 0) {
                console.log(
                  '[CHECKSTAGING] %s attempt to poweron, attach to network',
                  vmid
                );
                this.powerOn(vmid);
                //this.attachToNetwork(id);
              }
              if (
                retryCount % (config.NODE_ENV === 'development' ? 1 : 30) ===
                0
              ) {
                console.log(
                  '[CHECKSTAGING]',
                  'not ready:',
                  vmid,
                  vm.host,
                  retryCount
                );
              }
            }
          }
          resolve(vmid + ', ' + retryCount + ', ' + ready);
        });
      });
      // TODO log something if we timeout
      const result = await Promise.race([
        Promise.allSettled(stagingPromises),
        new Promise((resolve) => setTimeout(resolve, 30000)),
      ]);
      return result;
    };

    console.log(
      '[VMWORKER] starting background jobs for %s',
      this.getPoolName()
    );

    setInterval(resizeVMGroupIncr, incrInterval);
    setInterval(resizeVMGroupDecr, decrInterval);
    setInterval(async () => {
      console.log(
        '[STATS] %s: currentSize %s, available %s, staging %s, buffer %s',
        this.getPoolName(),
        await this.getCurrentSize(),
        await this.getAvailableCount(),
        await this.getStagingCount(),
        this.getAdjustedBuffer()
      );
    }, 10000);

    setImmediate(async () => {
      while (true) {
        try {
          await cleanupVMGroup();
        } catch (e: any) {
          console.warn('[CLEANUPVMGROUP-ERROR]', e.response?.data);
        }
        await new Promise((resolve) => setTimeout(resolve, cleanupInterval));
      }
    });

    setImmediate(async () => {
      while (true) {
        try {
          await checkStaging();
        } catch (e) {
          console.warn('[CHECKSTAGING-ERROR]', e);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  };

  public abstract id: string;
  protected abstract size: string;
  protected abstract largeSize: string;
  protected abstract minRetries: number;
  protected abstract startVM: (name: string) => Promise<string>;
  protected abstract rebootVM: (id: string) => Promise<void>;
  protected abstract terminateVM: (id: string) => Promise<void>;
  public abstract getVM: (id: string) => Promise<VM | null>;
  protected abstract listVMs: (filter?: string) => Promise<VM[]>;
  protected abstract powerOn: (id: string) => Promise<void>;
  protected abstract attachToNetwork: (id: string) => Promise<void>;
  protected abstract mapServerObject: (server: any) => VM;
  public abstract updateSnapshot: () => Promise<string>;
}

async function checkVMReady(host: string) {
  const url = 'https://' + host.replace('/', '/health');
  try {
    // const out = execSync(`curl -i -L -v --ipv4 '${host}'`);
    // if (!out.toString().startsWith('OK') && !out.toString().startsWith('404 page not found')) {
    //   throw new Error('mismatched response from health');
    // }
    const resp = await axios({
      method: 'GET',
      url,
      timeout: 1000,
    });
    const timeSinceBoot = Date.now() / 1000 - Number(resp.data);
    // console.log(timeSinceBoot);
    return process.env.NODE_ENV === 'production'
      ? timeSinceBoot < 60 * 1000
      : true;
  } catch (e) {
    // console.log(url, e.message, e.response?.status);
    return false;
  }
}

function pointInInterval24(x: number, a: number, b: number) {
  return nonNegativeMod(x - a, 24) <= nonNegativeMod(b - a, 24);
}

function nonNegativeMod(n: number, m: number) {
  return ((n % m) + m) % m;
}

export interface VM {
  id: string;
  pass: string;
  host: string;
  private_ip: string;
  state: string;
  tags: string[];
  creation_date: string;
  provider: string;
  originalName?: string;
  large: boolean;
  region: string;
}

export interface AssignedVM extends VM {
  assignTime: number;
  controllerClient?: string;
  creatorUID?: string;
  creatorClientID?: string;
}

export interface VMManagers {
  standard: VMManager | null;
  large: VMManager | null;
  US: VMManager | null;
}
