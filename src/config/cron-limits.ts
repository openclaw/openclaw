export const DEFAULT_CRON_ENABLED = true;
/**
 * Automation runs that conversations never take away: automation may use more of the agent
 * concurrency limit that conversations leave free. Low free memory can still hold it below this.
 */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
