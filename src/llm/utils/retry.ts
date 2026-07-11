import type { AssistantMessage, ServerRetryAfter } from "../types.js";

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
 * Classify a parsed Retry-After value into the closed {@link ServerRetryAfter}
 * result. `parseRetryAfterSeconds` returns `Infinity` for an overflowed /
 * unparseably-large header; that becomes `{ kind: "unbounded" }` so the
 * over-limit case can never be silently dropped by a finite-only downstream.
 */
export function toServerRetryAfter(seconds: number | undefined): ServerRetryAfter | undefined {
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return undefined;
  }
  return Number.isFinite(seconds) ? { kind: "seconds", seconds } : { kind: "unbounded" };
}

/**
 * Resolve the wait before an automatic in-turn retry, honoring a server cooldown.
 *
 * The base schedule is exponential backoff (`baseDelayMs * 2 ** (attempt - 1)`).
 * A finite server cooldown is treated as a lower bound so genuinely rate-limited
 * turns wait out the server's window instead of resending inside it.
 *
 * `maxRetryDelayMs` is the operator-configured maximum in-turn sleep
 * (`retry.provider.maxRetryDelayMs`, default 60s) — and it is the *only* ceiling
 * this function applies. A finite cooldown within the bound is honored in full;
 * a finite cooldown above it, or an `unbounded` (over-limit) cooldown, returns
 * `null` so the caller stops retrying in-turn and lets provider fallback /
 * operator recovery proceed rather than holding the session asleep. Absent
 * cooldown uses the exponential delay (itself capped at `maxRetryDelayMs`).
 */
export function resolveAutoRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxRetryDelayMs: number;
  retryAfter?: ServerRetryAfter;
}): number | null {
  const exponentialMs = params.baseDelayMs * 2 ** (params.attempt - 1);
  const { retryAfter } = params;
  if (retryAfter) {
    if (retryAfter.kind === "unbounded") {
      return null;
    }
    const retryAfterMs = retryAfter.seconds * 1000;
    if (retryAfterMs > params.maxRetryDelayMs) {
      return null;
    }
    return Math.min(Math.max(exponentialMs, retryAfterMs), params.maxRetryDelayMs);
  }
  return Math.min(exponentialMs, params.maxRetryDelayMs);
}
