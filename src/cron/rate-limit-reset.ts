import { isFailoverError } from "../agents/failover/error.js";
import { MODEL_FALLBACK_SKIPPED_CODE } from "../agents/model-fallback.types.js";

/**
 * The provider's stated rate-limit reset, when every failed model attempt was rate-limited with
 * a known reset: the earliest of them, since that candidate can run again first. A leaf module:
 * session-event settlement reads it without importing the failover copy owners.
 */
export function resolveCronRateLimitResetAt(error: unknown): number | undefined {
  if (!isFailoverError(error)) {
    return undefined;
  }
  // The failover owner records each attempt's parsed reset; a lone attempt is the error itself.
  // A candidate skipped for a local cooldown made no request and states no reset.
  const resets = (error.attempts?.length ? error.attempts : [error])
    .filter((attempt) => attempt.code !== MODEL_FALLBACK_SKIPPED_CODE)
    .map((attempt) => (attempt.reason === "rate_limit" ? attempt.rateLimitResetAt : undefined));
  const resetAt =
    resets.length > 0 && resets.every((value): value is number => value !== undefined)
      ? Math.min(...resets)
      : undefined;
  // A reset the scheduler cannot represent must not clear the job's schedule.
  return Number.isFinite(resetAt) ? resetAt : undefined;
}
