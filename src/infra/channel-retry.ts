/**
 * Unified retry infrastructure for all messaging channels.
 *
 * Provides consistent retry behavior across Telegram, Discord, Signal, iMessage,
 * WhatsApp, Line, and other channels to handle network failures gracefully.
 */

import { retryAsync, type RetryOptions } from "./retry.js";

export interface ChannelRetryConfig {
  /** Channel name for logging (e.g., "telegram", "signal", "discord") */
  channelName: string;
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay between retries in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Backoff factor for exponential backoff (default: 2) */
  factor?: number;
  /** Jitter factor to randomize delays (default: 0.2 = 20%) */
  jitter?: number;
  /** Overall timeout for the entire retry sequence in milliseconds (default: 60000 = 1 minute) */
  overallTimeoutMs?: number;
}

const DEFAULT_RETRY_CONFIG: Required<Omit<ChannelRetryConfig, "channelName">> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
  overallTimeoutMs: 60_000,
};

/**
 * Check if an error is a recoverable network error.
 */
function isRecoverableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();

  // Common network error patterns
  const networkPatterns = [
    "network",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "socket hang up",
    "fetch failed",
    "request failed",
    "connection",
    "unreachable",
  ];

  return networkPatterns.some((pattern) => message.includes(pattern));
}

/**
 * Check if an error is a rate limit error.
 */
function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();

  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429")
  );
}

/**
 * Create a retry runner for a specific channel.
 *
 * @param config - Channel retry configuration
 * @returns A function that wraps operations with retry logic
 *
 * @example
 * ```typescript
 * const retryRunner = createChannelRetryRunner({
 *   channelName: "signal",
 *   maxAttempts: 3,
 *   overallTimeoutMs: 60_000,
 * });
 *
 * const result = await retryRunner(async () => {
 *   return await sendSignalMessage(message);
 * });
 * ```
 */
export function createChannelRetryRunner(config: ChannelRetryConfig) {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  return async function retryChannelOperation<T>(operation: () => Promise<T>): Promise<T> {
    const startTime = Date.now();

    const retryConfig: RetryOptions = {
      attempts: fullConfig.maxAttempts,
      minDelayMs: fullConfig.initialDelayMs,
      maxDelayMs: fullConfig.maxDelayMs,
      jitter: fullConfig.jitter,
      shouldRetry: (err: unknown, attempt: number) => {
        // Check overall timeout
        const elapsed = Date.now() - startTime;
        if (elapsed >= fullConfig.overallTimeoutMs) {
          console.warn(
            `[${fullConfig.channelName}] Retry timeout after ${elapsed}ms (overall timeout: ${fullConfig.overallTimeoutMs}ms)`,
          );
          return false;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= fullConfig.maxAttempts) {
          return false;
        }

        // Retry on network errors and rate limits
        const isRecoverable = isRecoverableNetworkError(err) || isRateLimitError(err);

        if (isRecoverable) {
          console.log(
            `[${fullConfig.channelName}] Retry attempt ${attempt}/${fullConfig.maxAttempts}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        return isRecoverable;
      },
      onRetry: (info) => {
        const elapsed = Date.now() - startTime;
        console.warn(
          `[${fullConfig.channelName}] Retry ${info.attempt}/${info.maxAttempts} after ${elapsed}ms: ${info.err instanceof Error ? info.err.message : String(info.err)}`,
        );
      },
    };

    return await retryAsync(operation, retryConfig);
  };
}

/**
 * Pre-configured retry runners for common channels.
 */
export const channelRetryRunners = {
  /**
   * Signal retry runner (for send operations).
   */
  signal: createChannelRetryRunner({
    channelName: "signal",
    maxAttempts: 3,
    overallTimeoutMs: 60_000,
  }),

  /**
   * iMessage retry runner (for send operations).
   */
  imessage: createChannelRetryRunner({
    channelName: "imessage",
    maxAttempts: 3,
    overallTimeoutMs: 60_000,
  }),

  /**
   * WhatsApp retry runner (for outbound operations).
   */
  whatsapp: createChannelRetryRunner({
    channelName: "whatsapp",
    maxAttempts: 3,
    overallTimeoutMs: 60_000,
  }),

  /**
   * Discord retry runner (for REST API calls).
   */
  discord: createChannelRetryRunner({
    channelName: "discord",
    maxAttempts: 3,
    maxDelayMs: 60_000, // Discord rate limits can be longer
    overallTimeoutMs: 120_000, // 2 minutes for Discord
  }),

  /**
   * Line retry runner (for webhook processing).
   */
  line: createChannelRetryRunner({
    channelName: "line",
    maxAttempts: 3,
    overallTimeoutMs: 60_000,
  }),

  /**
   * Telegram retry runner (for operations not covered by existing retry).
   */
  telegram: createChannelRetryRunner({
    channelName: "telegram",
    maxAttempts: 3,
    overallTimeoutMs: 60_000,
  }),
};
