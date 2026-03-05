import { type CheckTimeDriftOpts, checkTimeDrift, formatDriftForLog } from "./time-drift.js";

export interface TimeDriftMonitorOpts extends CheckTimeDriftOpts {
  /** Periodic check interval in minutes.  0 disables periodic checks. */
  intervalMinutes?: number;
  /** Logger with `.info(msg)`, `.warn(msg)`, `.error(msg)`. */
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface TimeDriftMonitor {
  /** Run a single drift check, logging the result. Returns whether drift exceeds threshold. */
  checkOnce: () => Promise<boolean>;
  /** Start periodic checks (no-op if intervalMinutes is 0). */
  start: () => void;
  /** Stop periodic checks. */
  stop: () => void;
}

const DEFAULT_INTERVAL_MINUTES = 60;

export function createTimeDriftMonitor(opts: TimeDriftMonitorOpts): TimeDriftMonitor {
  const { log } = opts;
  const intervalMinutes = opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function checkOnce(): Promise<boolean> {
    try {
      const result = await checkTimeDrift(opts);
      const msg = `time-drift: ${formatDriftForLog(result)}`;
      if (result.exceeds) {
        log.warn(msg);
      } else {
        log.info(msg);
      }
      return result.exceeds;
    } catch (err) {
      log.error(`time-drift: check failed — ${String(err)}`);
      return false;
    }
  }

  function start(): void {
    if (intervalMinutes <= 0 || timer) {
      return;
    }
    const ms = intervalMinutes * 60_000;
    timer = setInterval(() => void checkOnce(), ms);
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { checkOnce, start, stop };
}
