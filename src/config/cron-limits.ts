export const DEFAULT_CRON_ENABLED = true;
/** Cron jobs that may run at once whatever the free memory. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
/** Most cron jobs that may run at once; runs past the default need free memory to start. */
export const MAX_CRON_CONCURRENT_RUNS = 16;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
