import type { AssistantMessage } from "../types.js";

/**
 * Decision for AgentSession auto-retry sleep.
 *
 * Contract (matches `maxRetryDelayMs` on StreamOptions / provider retry settings):
 * - positive max: honor full server Retry-After when it is ≤ max; decline auto-retry
 *   when the server asks for longer so higher-level handling can surface the wait
 * - zero max: cap disabled — honor the full server Retry-After (and exponential floor)
 * - no/invalid Retry-After: exponential backoff only
 */
export type AutoRetryDelayDecision =
  | { action: "delay"; delayMs: number }
  | {
      action: "no_auto_retry";
      reason: "retry_after_exceeds_max";
      retryAfterMs: number;
      maxRetryDelayMs: number;
    };

/**
 * Resolve AgentSession auto-retry sleep from exponential backoff + server Retry-After.
 * Returns `no_auto_retry` when a positive max is set and the server cooldown exceeds it.
 */
export function resolveAutoRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  retryAfterSeconds?: number;
  maxRetryDelayMs: number;
}): AutoRetryDelayDecision {
  const attempt = Math.max(1, Math.trunc(params.attempt));
  const baseDelayMs = Math.max(0, params.baseDelayMs);
  const exponentialDelayMs = baseDelayMs * 2 ** (attempt - 1);
  // 0 means "unlimited" (cap disabled). Do not Math.max(0, …) away the zero signal.
  const maxRetryDelayMs = Number.isFinite(params.maxRetryDelayMs)
    ? Math.max(0, params.maxRetryDelayMs)
    : 0;
  const retryAfterSeconds = params.retryAfterSeconds;
  if (
    retryAfterSeconds === undefined ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) {
    return { action: "delay", delayMs: exponentialDelayMs };
  }
  const retryAfterDelayMs = Math.ceil(retryAfterSeconds * 1000);
  // Positive max: over-cap cooldowns must not auto-retry early.
  if (maxRetryDelayMs > 0 && retryAfterDelayMs > maxRetryDelayMs) {
    return {
      action: "no_auto_retry",
      reason: "retry_after_exceeds_max",
      retryAfterMs: retryAfterDelayMs,
      maxRetryDelayMs,
    };
  }
  // Within cap (or unlimited when max is 0): honor full Retry-After as a floor.
  return {
    action: "delay",
    delayMs: Math.max(exponentialDelayMs, retryAfterDelayMs),
  };
}

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
