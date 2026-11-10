import type { CronConfig } from "./types.cron.js";

export const DEFAULT_CRON_ENABLED = true;
/** Default maximum number of cron jobs allowed to run at once. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/** Uses the validated concurrency override, preserving the default when unset. */
export function resolveCronMaxConcurrentRuns(
  cronConfig?: Pick<CronConfig, "maxConcurrentRuns">,
): number {
  return cronConfig?.maxConcurrentRuns ?? DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
