import { RateLimitError } from "@buape/carbon";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

export const TELEGRAM_RETRY_DEFAULTS = {
  attempts: 4,
  minDelayMs: 500,
  maxDelayMs: 60_000,
  jitter: 0.15,
};

const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;
const log = createSubsystemLogger("retry-policy");

function resolveTelegramShouldRetry(params: {
  shouldRetry?: (err: unknown) => boolean;
  strictShouldRetry?: boolean;
}) {
  if (!params.shouldRetry) {
    return (err: unknown) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));
  }
  if (params.strictShouldRetry) {
    return params.shouldRetry;
  }
  return (err: unknown) =>
    params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err));
}

function extractRetryAfterCandidate(err: unknown): unknown {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Direct parameters (grammY HttpError shape)
  if ("parameters" in err && err.parameters && typeof err.parameters === "object") {
    return (err.parameters as { retry_after?: unknown }).retry_after;
  }
  // Nested response.parameters
  if (
    "response" in err &&
    err.response &&
    typeof err.response === "object" &&
    "parameters" in err.response
  ) {
    return (err.response as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
  }
  // Nested error.parameters (wrapped HttpError)
  if ("error" in err && err.error && typeof err.error === "object" && "parameters" in err.error) {
    return (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
  }
  // Cause chain traversal for deeply wrapped errors
  if ("cause" in err && err.cause && typeof err.cause === "object") {
    return extractRetryAfterCandidate(err.cause);
  }
  return undefined;
}

function getTelegramRetryAfterMs(err: unknown): number | undefined {
  const candidate = extractRetryAfterCandidate(err);
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    const delayMs = candidate * 1000;
    log.warn(`telegram 429 rate limit: retry_after=${candidate}s (${delayMs}ms)`);
    return delayMs;
  }
  // Fallback: detect 429 from message and use default backoff
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/429|too many requests/i.test(msg) && candidate === undefined) {
    const defaultBackoffMs = 5_000;
    log.warn(
      `telegram 429 rate limit detected (no retry_after header), using ${defaultBackoffMs}ms default backoff`,
    );
    return defaultBackoffMs;
  }
  return undefined;
}

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => err instanceof RateLimitError,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

export function createTelegramRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  /**
   * When true, the custom shouldRetry predicate is used exclusively —
   * the default TELEGRAM_RETRY_RE fallback regex is NOT OR'd in.
   * Use this for non-idempotent operations (e.g. sendMessage) where
   * the regex fallback would cause duplicate message delivery.
   */
  strictShouldRetry?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  const shouldRetry = resolveTelegramShouldRetry(params);

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: getTelegramRetryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}
