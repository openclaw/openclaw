import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

export const CHANNEL_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
  // Without a per-call ceiling, a hung upstream HTTP call (e.g. a grammY
  // bot.api.* request that never resolves) wedges the whole retry runner
  // and the surrounding CLI invocation forever. 30s converts the hang into
  // a real timeout error; the default shouldRetry regex matches "timeout"
  // so the runner naturally retries before giving up.
  perCallTimeoutMs: 30_000,
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
  /**
   * Channel's own per-request timeout in seconds (for example Telegram's
   * `timeoutSeconds`). When neither the explicit `retry.perCallTimeoutMs`
   * argument nor the channel `configRetry.perCallTimeoutMs` is set, this
   * value is used as the per-attempt timeout (converted to milliseconds)
   * so the channel's existing timeout setting is honored before the
   * generic retry default kicks in. Priority:
   *   explicit `retry.perCallTimeoutMs`
   *   > `configRetry.perCallTimeoutMs`
   *   > `channelTimeoutSeconds * 1000`
   *   > `CHANNEL_API_RETRY_DEFAULTS.perCallTimeoutMs`.
   */
  channelTimeoutSeconds?: number;
}): RetryRunner {
  const explicitPerCallTimeoutMs =
    params.retry?.perCallTimeoutMs ?? params.configRetry?.perCallTimeoutMs;
  const channelDerivedPerCallTimeoutMs =
    explicitPerCallTimeoutMs === undefined &&
    typeof params.channelTimeoutSeconds === "number" &&
    Number.isFinite(params.channelTimeoutSeconds) &&
    params.channelTimeoutSeconds > 0
      ? Math.floor(params.channelTimeoutSeconds) * 1000
      : undefined;
  const retryConfig = resolveRetryConfig(CHANNEL_API_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
    // Channel-derived per-call timeout only applies when neither explicit
    // override was provided. The `explicitPerCallTimeoutMs === undefined`
    // guard above makes this spread a no-op when an explicit value exists,
    // so the explicit value still wins despite appearing earlier in the
    // spread chain.
    ...(channelDerivedPerCallTimeoutMs !== undefined
      ? { perCallTimeoutMs: channelDerivedPerCallTimeoutMs }
      : {}),
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
