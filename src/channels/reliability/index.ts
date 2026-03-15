/**
 * Channel reliability module exports.
 */

export {
  type RetryPolicy,
  type RetryContext,
  type RetryResult,
  DEFAULT_RETRY_POLICY,
  AGGRESSIVE_RETRY_POLICY,
  LIGHT_RETRY_POLICY,
  calculateBackoff,
  withRetry,
  withRetryResult,
} from "./retry.js";

export {
  type IdempotencyStore,
  buildIdempotencyKey,
  createInMemoryIdempotencyStore,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  SHORT_IDEMPOTENCY_TTL_MS,
  LONG_IDEMPOTENCY_TTL_MS,
  withIdempotency,
} from "./idempotency.js";

export {
  ChannelErrorCode,
  RECOVERABLE_ERROR_CODES,
  PERMANENT_ERROR_CODES,
  type ChannelErrorOptions,
  ChannelError,
  isChannelError,
  isRecoverableChannelError,
  wrapAsChannelError,
  detectErrorCode,
} from "./errors.js";
