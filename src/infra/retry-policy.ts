import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

export const CHANNEL_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

const CHANNEL_API_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;
const log = createSubsystemLogger("retry-policy");

function resolveChannelApiShouldRetry(params: {
  shouldRetry?: (err: unknown) => boolean;
  strictShouldRetry?: boolean;
}) {
  if (!params.shouldRetry) {
    return (err: unknown) => CHANNEL_API_RETRY_RE.test(formatErrorMessage(err));
  }
  if (params.strictShouldRetry) {
    return params.shouldRetry;
  }
  return (err: unknown) =>
    params.shouldRetry?.(err) || CHANNEL_API_RETRY_RE.test(formatErrorMessage(err));
}

function getChannelApiRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    "parameters" in err && err.parameters && typeof err.parameters === "object"
      ? (err.parameters as { retry_after?: unknown }).retry_after
      : "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "parameters" in err.response
        ? (
            err.response as {
              parameters?: { retry_after?: unknown };
            }
          ).parameters?.retry_after
        : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
          ? (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
          : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}

export function createRateLimitRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  defaults: Required<RetryConfig>;
  logLabel: string;
  shouldRetry: (err: unknown) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(params.defaults, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: params.shouldRetry,
      retryAfterMs: params.retryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `${params.logLabel} ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

// --- Provider (LLM) API retry ---

export const PROVIDER_API_RETRY_DEFAULTS: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.15,
};

const PROVIDER_API_RETRY_RE =
  /429|timeout|connect|reset|closed|unavailable|temporarily|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|502|503|504/i;

function getProviderApiRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // OpenAI SDK errors expose headers with retry-after
  const headers =
    "headers" in err && err.headers && typeof err.headers === "object"
      ? (err.headers as Record<string, unknown>)
      : undefined;
  const retryAfter = headers?.["retry-after"];
  if (typeof retryAfter === "string") {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return undefined;
}

function isNonRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const status = "status" in err ? (err.status as number) : undefined;
  // Client errors that are never retryable
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export function createProviderApiRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(PROVIDER_API_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err: unknown) => {
        if (isNonRetryableProviderError(err)) {
          return false;
        }
        return PROVIDER_API_RETRY_RE.test(formatErrorMessage(err));
      },
      retryAfterMs: getProviderApiRetryAfterMs,
      onRetry: (info) => {
        const maxRetries = Math.max(1, info.maxAttempts - 1);
        log.warn(
          `provider retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
        );
      },
    });
}

// --- Channel API retry ---

export function createChannelApiRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
  /**
   * When true, the custom shouldRetry predicate is used exclusively —
   * the default channel API fallback regex is NOT OR'd in.
   * Use this for non-idempotent operations (e.g. sendMessage) where
   * the regex fallback would cause duplicate message delivery.
   */
  strictShouldRetry?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(CHANNEL_API_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  const shouldRetry = resolveChannelApiShouldRetry(params);

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: getChannelApiRetryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `channel send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}
