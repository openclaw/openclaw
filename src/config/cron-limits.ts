export const DEFAULT_CRON_ENABLED = true;
/**
 * Most cron jobs allowed to run at once. Low free memory holds automation to one run at a time
 * below this; see `resolveCronRunSlots`.
 */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 16;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves cron concurrency config, flooring finite values and clamping to at least one. */
export function resolveCronMaxConcurrentRuns(): number {
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
