import type { CronConfig } from "../../config/types.cron.js";

/**
 * Default exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

/**
 * Error kinds used to classify execution failures for retry/backoff decisions.
 * - `transient`: network timeouts, rate limits, temporary provider errors → retry with backoff
 * - `terminal`: invalid config, missing permissions, bad payload → no retry
 * - `delivery-target`: delivery channel resolution failed (existing kind, preserved for compat)
 */
export type CronErrorKind = "transient" | "terminal" | "delivery-target";

/**
 * Resolve the backoff schedule to use for a given cron config.
 * Returns the user-configured schedule if valid, otherwise the default.
 */
export function resolveBackoffSchedule(cronConfig?: CronConfig): readonly number[] {
  const custom = cronConfig?.retryBackoff;
  if (!Array.isArray(custom) || custom.length === 0) {
    return DEFAULT_ERROR_BACKOFF_SCHEDULE_MS;
  }
  const validated = custom.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return validated.length > 0 ? validated : DEFAULT_ERROR_BACKOFF_SCHEDULE_MS;
}

/**
 * Compute the backoff delay for a given consecutive error count using the
 * provided schedule. Falls back to the default schedule when omitted.
 */
export function errorBackoffMs(
  consecutiveErrors: number,
  schedule: readonly number[] = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(consecutiveErrors - 1, schedule.length - 1);
  return schedule[Math.max(0, idx)];
}

/** Patterns that indicate transient (retriable) errors. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /socket hang up/i,
  /rate.?limit/i,
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /network/i,
  /fetch failed/i,
  /abort/i,
];

/** Patterns that indicate terminal (non-retriable) errors. */
const TERMINAL_PATTERNS: readonly RegExp[] = [
  /not allowed/i,
  /invalid.*config/i,
  /missing.*permission/i,
  /\b401\b/,
  /\b403\b/,
  /not found.*model/i,
  /payload.*require/i,
];

/**
 * Classify an execution error to guide retry behaviour.
 *
 * - `terminal` errors disable the job immediately (no backoff retries).
 * - `transient` errors use exponential backoff.
 * - `delivery-target` is preserved for the existing delivery-target error path.
 *
 * Defaults to `transient` to avoid prematurely disabling jobs.
 */
export function classifyRunErrorKind(error: string | undefined): CronErrorKind {
  if (!error) {
    return "transient";
  }
  if (TERMINAL_PATTERNS.some((re) => re.test(error))) {
    return "terminal";
  }
  if (TRANSIENT_PATTERNS.some((re) => re.test(error))) {
    return "transient";
  }
  // Default to transient to avoid prematurely disabling jobs on unknown errors.
  return "transient";
}
