// Computes cron scheduling limits from config.
import { parseDurationMs } from "../cli/parse-duration.js";
import type { CronConfig } from "./types.cron.js";

/** Default maximum number of cron jobs allowed to run at once. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;

/** No floor: `0` disables the minimum-interval guardrail for recurring jobs. */
export const DEFAULT_CRON_MIN_INTERVAL_MS = 0;

/** Resolves cron concurrency config, flooring finite values and clamping to at least one. */
export function resolveCronMaxConcurrentRuns(
  cronConfig?: Pick<CronConfig, "maxConcurrentRuns">,
): number {
  const raw = cronConfig?.maxConcurrentRuns;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

/**
 * Resolves the configured minimum interval (ms) for recurring cron jobs.
 * Numbers are treated as milliseconds; strings parse as durations (default unit
 * ms). Invalid or missing values fall back to no floor so a bad config never
 * silently blocks scheduling — config-load validation reports the bad value.
 */
export function resolveCronMinIntervalMs(cronConfig?: Pick<CronConfig, "minInterval">): number {
  const raw = cronConfig?.minInterval;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return DEFAULT_CRON_MIN_INTERVAL_MS;
    }
    try {
      return Math.max(0, Math.floor(parseDurationMs(trimmed, { defaultUnit: "ms" })));
    } catch {
      return DEFAULT_CRON_MIN_INTERVAL_MS;
    }
  }
  return DEFAULT_CRON_MIN_INTERVAL_MS;
}
