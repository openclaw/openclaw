import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

/**
 * Optional behavior knobs at call time. `signal` makes backoff cancellable
 * (interrupted sleeps reject; the most recent attempt's error is rethrown)
 * so a request abort doesn't stall up to one backoff interval.
 */
export type RetryRunOptions = {
  signal?: AbortSignal;
};

export type RetryRunner = <T>(
  fn: () => Promise<T>,
  labelOrOptions?: string | RetryRunOptions,
  options?: RetryRunOptions,
) => Promise<T>;

function resolveRunnerOptions(
  labelOrOptions?: string | RetryRunOptions,
  options?: RetryRunOptions,
): { label?: string; signal?: AbortSignal } {
  if (typeof labelOrOptions === "string") {
    return { label: labelOrOptions, signal: options?.signal };
  }
  if (labelOrOptions && typeof labelOrOptions === "object") {
    return { label: undefined, signal: labelOrOptions.signal };
  }
  return { label: undefined, signal: options?.signal };
}

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
  return <T>(
    fn: () => Promise<T>,
    labelOrOptions?: string | RetryRunOptions,
    runOptions?: RetryRunOptions,
  ) => {
    const { label, signal } = resolveRunnerOptions(labelOrOptions, runOptions);
    return retryAsync(fn, {
      ...retryConfig,
      label,
      signal,
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
  };
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

function readRetryAfterHeader(headers: object): unknown {
  // Headers can arrive in two shapes:
  //  - fetch `Headers` instances (Web APIs, Node 18+, undici-based clients):
  //    bracket access returns undefined; must call `.get("retry-after")`.
  //  - plain objects (older OpenAI SDK error shapes, axios responses):
  //    bracket access works but case may not be normalized.
  // HTTP header names are case-insensitive; `Headers.get` handles that
  // internally. For plain objects we probe common case variants.
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    try {
      return (headers as Headers).get("retry-after");
    } catch {
      // If the object exposes a `get` method that doesn't match the
      // Headers signature, fall through to bracket access.
    }
  }
  const bag = headers as Record<string, unknown>;
  return bag["retry-after"] ?? bag["Retry-After"] ?? bag["RETRY-AFTER"];
}

function getProviderApiRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (!("headers" in err) || !err.headers || typeof err.headers !== "object") {
    return undefined;
  }
  const retryAfter = readRetryAfterHeader(err.headers);
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
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

export function createProviderApiRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(PROVIDER_API_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });

  return <T>(
    fn: () => Promise<T>,
    labelOrOptions?: string | RetryRunOptions,
    runOptions?: RetryRunOptions,
  ) => {
    const { label, signal } = resolveRunnerOptions(labelOrOptions, runOptions);
    return retryAsync(fn, {
      ...retryConfig,
      label,
      signal,
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
  };
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

  return <T>(
    fn: () => Promise<T>,
    labelOrOptions?: string | RetryRunOptions,
    runOptions?: RetryRunOptions,
  ) => {
    const { label, signal } = resolveRunnerOptions(labelOrOptions, runOptions);
    return retryAsync(fn, {
      ...retryConfig,
      label,
      signal,
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
  };
}
