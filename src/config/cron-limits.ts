export const DEFAULT_CRON_ENABLED = true;
/**
 * Run slots automation always has, whatever conversations are doing. Beyond these, automation
 * uses the part of the agent concurrency limit that conversations leave free.
 */
export const MIN_CRON_RUN_SLOTS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
