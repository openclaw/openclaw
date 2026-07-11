import type { AssistantMessage } from "../types.js";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded",
  "rate.?limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "service.?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?error",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "timed? out",
  "timeout",
  "terminated",
  "websocket.?closed",
  "websocket.?error",
  "ended without",
  "stream ended before message_stop",
  "http2 request did not get a response",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
]);

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}

/**
 * Resolve the wait before an automatic in-turn retry, honoring a server cooldown.
 *
 * The base schedule is exponential backoff (`baseDelayMs * 2 ** (attempt - 1)`).
 * A server-supplied `retryAfterSeconds` (e.g. from a 429 `Retry-After` header) is
 * treated as a lower bound, so genuinely rate-limited turns wait out the server's
 * cooldown instead of resending inside it.
 *
 * `maxRetryDelayMs` is the operator-configured maximum server-requested wait
 * (`retry.provider.maxRetryDelayMs`, default 60s). A server cooldown within this
 * bound is honored in full; a cooldown that exceeds it returns `null` so the
 * caller stops retrying in-turn and lets provider fallback / operator recovery
 * proceed, rather than holding the session asleep for minutes or hours. Invalid
 * hints (non-finite, zero, or negative) are ignored and the exponential delay is
 * used (itself capped at `maxRetryDelayMs`).
 */
export function resolveAutoRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxRetryDelayMs: number;
  retryAfterSeconds?: number;
}): number | null {
  const exponentialMs = params.baseDelayMs * 2 ** (params.attempt - 1);
  if (typeof params.retryAfterSeconds === "number" && params.retryAfterSeconds > 0) {
    const retryAfterMs = params.retryAfterSeconds * 1000;
    if (retryAfterMs > params.maxRetryDelayMs) {
      return null;
    }
    return Math.min(Math.max(exponentialMs, retryAfterMs), params.maxRetryDelayMs);
  }
  return Math.min(exponentialMs, params.maxRetryDelayMs);
}
