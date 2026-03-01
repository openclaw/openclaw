/**
 * Rate limiting & cost control for external API calls.
 *
 * @module rate-limits
 *
 * Entry points:
 * - `withRateLimit()` — wrap any API call with rate limiting, budget checks, and 429 retry
 * - `resolveRateLimitsConfig()` — resolve limits config from openclaw.yaml
 * - `getRateLimitedRunner()` — singleton access to the RateLimitedRunner
 */

export { resolveRateLimitsConfig } from "./config.js";
export { getRateLimitedRunner, resetRateLimitedRunner } from "./provider-wrapper.js";
export { SlidingWindowLimiter } from "./limiter.js";
export { BudgetTracker } from "./budget.js";
export { RateLimitQueue } from "./queue.js";
export {
  logRateLimitAcquired,
  logRateLimitQueued,
  logRateLimitRejected,
  logBudgetWarning,
  logBudgetExceeded,
  logRetryAfter429,
  getMetricsSnapshot,
  clearMetricsSnapshot,
} from "./metrics.js";
export type {
  RateLimitScope,
  RateLimitProviderConfig,
  ResolvedLimitsConfig,
  BudgetWarning,
  LimiterWindowState,
  AcquireResult,
  BudgetCheckResult,
  ProviderLimitsStatus,
} from "./types.js";
