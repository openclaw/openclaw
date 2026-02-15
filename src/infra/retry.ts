import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "./backoff.js";

/**
 * Error thrown when all retry attempts have been exhausted.
 * Contains the original error from the last attempt.
 */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`All ${attempts} retry attempts exhausted: ${lastError.message}`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Predicate to determine if an error should trigger a retry.
 * Return true to retry, false to immediately throw.
 */
export type ShouldRetryFn = (error: Error, attempt: number) => boolean;

/**
 * Callback invoked before each retry attempt.
 * Useful for logging or metrics collection.
 */
export type OnRetryFn = (error: Error, attempt: number, delayMs: number) => void;

export type RetryOptions = {
  /**
   * Maximum number of attempts (including the initial attempt).
   * Must be at least 1. Default: 3
   */
  maxAttempts?: number;

  /**
   * Backoff policy for calculating delay between retries.
   * Default: { initialMs: 1000, maxMs: 30000, factor: 2, jitter: 0.1 }
   */
  backoffPolicy?: BackoffPolicy;

  /**
   * Predicate to determine if a specific error should be retried.
   * Default: retry all errors
   */
  shouldRetry?: ShouldRetryFn;

  /**
   * Callback invoked before each retry attempt.
   * Receives the error, attempt number, and calculated delay.
   */
  onRetry?: OnRetryFn;

  /**
   * AbortSignal to cancel retries early.
   * When aborted, the current sleep is interrupted.
   */
  abortSignal?: AbortSignal;
};

const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1000,
  maxMs: 30000,
  factor: 2,
  jitter: 0.1,
};

/**
 * Execute an async operation with automatic retry on failure.
 *
 * Uses exponential backoff with jitter between attempts.
 * The backoff calculation is delegated to the existing computeBackoff function
 * to maintain consistency across the codebase.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetchData(url),
 *   {
 *     maxAttempts: 5,
 *     shouldRetry: (err) => err.message.includes('ECONNRESET'),
 *     onRetry: (err, attempt, delay) => {
 *       logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`);
 *     },
 *   }
 * );
 * ```
 *
 * @param operation - Async function to execute
 * @param options - Retry configuration options
 * @returns The result of the operation on success
 * @throws RetryExhaustedError when all attempts fail
 * @throws The original error if shouldRetry returns false
 * @throws Error("aborted") if the abort signal is triggered
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffPolicy = options.backoffPolicy ?? DEFAULT_BACKOFF_POLICY;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const onRetry = options.onRetry;
  const abortSignal = options.abortSignal;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check abort before each attempt
    if (abortSignal?.aborted) {
      throw new Error("aborted");
    }

    try {
      return await operation();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // Check if we've exhausted all attempts
      if (attempt >= maxAttempts) {
        break;
      }

      // Check if this error type should be retried
      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      // Calculate delay using the centralized backoff logic
      const delayMs = computeBackoff(backoffPolicy, attempt);

      // Notify callback before sleeping
      if (onRetry) {
        onRetry(error, attempt, delayMs);
      }

      // Sleep with abort support
      await sleepWithAbort(delayMs, abortSignal);
    }
  }

  // All attempts exhausted
  throw new RetryExhaustedError(maxAttempts, lastError!);
}

/**
 * Common retry predicates for typical error scenarios.
 */
export const retryPredicates = {
  /**
   * Retry on network-related errors (connection reset, timeout, DNS).
   */
  networkErrors: (error: Error): boolean => {
    const message = error.message.toLowerCase();
    const networkPatterns = [
      "econnreset",
      "econnrefused",
      "etimedout",
      "enotfound",
      "enetunreach",
      "ehostunreach",
      "socket hang up",
      "network",
      "timeout",
      "dns",
    ];
    return networkPatterns.some((pattern) => message.includes(pattern));
  },

  /**
   * Retry on HTTP 5xx server errors and rate limiting (429).
   * Expects error to have a 'status' or 'statusCode' property.
   */
  serverErrors: (error: Error): boolean => {
    const statusError = error as Error & { status?: number; statusCode?: number };
    const status = statusError.status ?? statusError.statusCode;
    if (typeof status !== "number") {
      return false;
    }
    // Retry on 429 (rate limit) and 5xx (server errors)
    return status === 429 || (status >= 500 && status < 600);
  },

  /**
   * Combine multiple predicates with OR logic.
   */
  any:
    (...predicates: ShouldRetryFn[]): ShouldRetryFn =>
    (error, attempt) =>
      predicates.some((p) => p(error, attempt)),
};
