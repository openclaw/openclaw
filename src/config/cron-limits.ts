export const DEFAULT_CRON_ENABLED = true;
/**
 * Most automation runs at once. With `cron.dynamicConcurrency` on, automation keeps at least
 * these and may use more of the agent concurrency limit that conversations leave free.
 */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
