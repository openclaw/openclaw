/**
 * Unified retry logic with exponential backoff for channel adapters.
 *
 * Usage:
 * ```typescript
 * const result = await withRetry(
 *   () => sendMessage(msg),
 *   DEFAULT_RETRY_POLICY,
 *   isRecoverableError,
 *   { correlationId: 'msg-123', channel: 'telegram', operation: 'send' }
 * );
 * ```
 */

import { getChildLogger } from "../../logging/logger.js";

const log = getChildLogger({ subsystem: "retry" });

export interface RetryPolicy {
  /** Maximum number of attempts (including initial) */
  maxAttempts: number;
  /** Base delay in milliseconds */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;
  /** Jitter factor (0-1) to randomize delays */
  jitterFactor: number;
}

export interface RetryContext {
  /** Unique identifier for tracing */
  correlationId: string;
  /** Channel name (telegram, discord, etc.) */
  channel: string;
  /** Operation being retried (send, fetch, etc.) */
  operation: string;
}

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: unknown;
  attempts: number;
  totalDelayMs: number;
}

/** Default retry policy suitable for most channel operations */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.2,
};

/** Aggressive retry policy for critical operations */
export const AGGRESSIVE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 60000,
  jitterFactor: 0.3,
};

/** Light retry policy for non-critical operations */
export const LIGHT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitterFactor: 0.1,
};

/**
 * Calculate backoff delay with exponential growth and jitter.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt) * (1 + random * jitter)
 */
export function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = 1 + Math.random() * policy.jitterFactor;
  return Math.round(cappedDelay * jitter);
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param fn - Async function to execute
 * @param policy - Retry policy configuration
 * @param isRecoverable - Function to check if error is recoverable
 * @param ctx - Context for logging and tracing
 * @returns Promise resolving to the function result
 * @throws Last error if all retries exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  isRecoverable: (err: unknown) => boolean,
  ctx: RetryContext,
): Promise<T> {
  let lastError: unknown;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        log.info(
          `[${ctx.correlationId}] ${ctx.channel}/${ctx.operation} succeeded on attempt ${attempt + 1}`,
        );
      }
      return result;
    } catch (err) {
      lastError = err;

      const isLast = attempt === policy.maxAttempts - 1;
      const recoverable = isRecoverable(err);

      if (!recoverable) {
        log.warn(
          `[${ctx.correlationId}] ${ctx.channel}/${ctx.operation} failed with non-recoverable error`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        throw err;
      }

      if (isLast) {
        log.error(
          `[${ctx.correlationId}] ${ctx.channel}/${ctx.operation} exhausted ${policy.maxAttempts} attempts`,
          { error: err instanceof Error ? err.message : String(err), totalDelayMs },
        );
        throw err;
      }

      const delayMs = calculateBackoff(attempt, policy);
      totalDelayMs += delayMs;

      log.info(
        `[${ctx.correlationId}] ${ctx.channel}/${ctx.operation} attempt ${attempt + 1} failed, ` +
          `retrying in ${delayMs}ms`,
        { error: err instanceof Error ? err.message : String(err) },
      );

      await sleep(delayMs);
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError;
}

/**
 * Execute with retry and return detailed result instead of throwing.
 */
export async function withRetryResult<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  isRecoverable: (err: unknown) => boolean,
  _ctx: RetryContext,
): Promise<RetryResult<T>> {
  let lastError: unknown;
  let totalDelayMs = 0;
  let attempts = 0;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    attempts = attempt + 1;
    try {
      const value = await fn();
      return { success: true, value, attempts, totalDelayMs };
    } catch (err) {
      lastError = err;

      const isLast = attempt === policy.maxAttempts - 1;
      const recoverable = isRecoverable(err);

      if (!recoverable || isLast) {
        return { success: false, error: err, attempts, totalDelayMs };
      }

      const delayMs = calculateBackoff(attempt, policy);
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }

  return { success: false, error: lastError, attempts, totalDelayMs };
}
