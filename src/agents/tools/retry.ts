/**
 * Retry utility with exponential backoff for transient failures.
 * Helps agents self-recover from temporary API issues without human intervention.
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Delay multiplier for exponential backoff (default: 2) */
  multiplier?: number;
  /** Custom error message formatter */
  formatError?: (error: Error, attempt: number, maxAttempts: number) => string;
}

export type RetryResult<T> =
  | { success: true; data: T; attempts: number }
  | { success: false; error: Error; attempts: number; lastError: Error };

/**
 * Execute a function with retry logic and exponential backoff.
 * Returns detailed result including number of attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, multiplier = 2 } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { success: true, data: result, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on the last attempt
      if (attempt === maxAttempts) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelayMs * Math.pow(multiplier, attempt - 1);
      const jitter = Math.random() * 0.2 * exponentialDelay; // ±10% jitter
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    success: false,
    error: lastError!,
    attempts: maxAttempts,
    lastError: lastError!,
  };
}

/**
 * Execute a function with retry logic, throwing on final failure.
 * Simpler API when you don't need detailed result info.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions & { throwOnFailure?: true } = {},
): Promise<T>;
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions & { throwOnFailure: false },
): Promise<T | null>;
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T | null> {
  const result = await withRetry(fn, options);

  if (result.success) {
    return result.data;
  }

  if (options.throwOnFailure !== false) {
    throw result.error;
  }

  return null;
}

/**
 * Check if an error is likely transient and worth retrying.
 */
export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Network/timeout errors
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enetunreach")
  ) {
    return true;
  }

  // Rate limiting (should retry after backoff)
  if (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("too many requests")
  ) {
    return true;
  }

  // Service unavailable/temporary errors
  if (
    message.includes("service unavailable") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504")
  ) {
    return true;
  }

  return false;
}
