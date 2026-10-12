import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, type RetryOptions, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

/** Default retry envelope for channel API operations that hit transient network edges. */
export const CHANNEL_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

const CHANNEL_API_RETRY_RE =
  /429|421|timeout|connect|reset|closed|unavailable|temporarily|misdirected request/i;
const log = createSubsystemLogger("retry-policy");

function resolveChannelApiShouldRetry(params: {
  shouldRetry?: RetryOptions["shouldRetry"];
  strictShouldRetry?: boolean;
}): NonNullable<RetryOptions["shouldRetry"]> {
  if (!params.shouldRetry) {
    return (err: unknown) => CHANNEL_API_RETRY_RE.test(formatErrorMessage(err));
  }
  if (params.strictShouldRetry) {
    return params.shouldRetry;
  }
  // Channel APIs often wrap network failures differently by provider. Keep the
  // fallback regex unless callers opt into strict idempotency control.
  return (err: unknown, attempt: number) =>
    params.shouldRetry?.(err, attempt) || CHANNEL_API_RETRY_RE.test(formatErrorMessage(err));
}

function getChannelApiRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Keep root/response/error precedence, but incomplete wrappers must not hide a valid hint.
  for (const key of [undefined, "response", "error"]) {
    const container: unknown = key === undefined ? err : Reflect.get(err, key);
    if (!container || typeof container !== "object" || !("parameters" in container)) {
      continue;
    }
    const parameters = container.parameters;
    if (!parameters || typeof parameters !== "object" || !("retry_after" in parameters)) {
      continue;
    }
    const candidate = parameters.retry_after;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate * 1000;
    }
  }
  return undefined;
}

export function createChannelApiRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  retryAfterMaxDelayMs?: number;
  shouldRetry?: RetryOptions["shouldRetry"];
  retryAfterMs?: RetryOptions["retryAfterMs"];
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
      retryAfterMs: params.retryAfterMs ?? getChannelApiRetryAfterMs,
      ...(params.retryAfterMaxDelayMs !== undefined
        ? { retryAfterMaxDelayMs: params.retryAfterMaxDelayMs }
        : {}),
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
