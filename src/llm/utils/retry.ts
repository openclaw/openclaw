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
  "insufficient[_ -]?quota",
  "current quota",
  "daily request limit",
  "weekly request limit",
  "monthly request limit",
  "tokens per day",
  "requests per day",
  "subscription",
  "out of budget",
]);

const PERMANENT_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "model\\b.*\\bnot(?:[_\\-\\s])?found",
  "model\\b.*\\bdoes not exist",
  "invalid[_\\-\\s]?api[_\\-\\s]?key",
  "\\bunauthorized\\b",
  "authentication failed",
  "image dimensions?.*\\bexceed",
]);

const LONG_WINDOW_RATE_LIMIT_PATTERN = buildProviderErrorPattern([
  "daily",
  "weekly",
  "monthly",
  "tokens per day",
  "requests per day",
  "usage limit",
  "subscription",
  "current quota",
  "insufficient[_ -]?quota",
]);

const SHORT_WINDOW_RATE_LIMIT_PATTERN = buildProviderErrorPattern([
  "requests per minute",
  "tokens per minute",
  "per-minute",
  "\\brpm\\b",
  "\\btpm\\b",
]);

const LONG_RETRY_AFTER_PATTERN =
  /\bretry[- ]after\b\s*:?\s*(?:in\s*)?(?:(?:6[1-9]|[7-9]\d|[1-9]\d{2,})(?:\s*(?:seconds?|secs?|s))?|\d+(?:\.\d+)?\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d))\b/i;

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded",
  "rate.?limit",
  "too many requests",
  "\\b429\\b",
  "\\b500\\b",
  "\\b502\\b",
  "\\b503\\b",
  "\\b504\\b",
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

function isNonRetryableAssistantErrorText(message: string): boolean {
  if (
    NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message) ||
    PERMANENT_PROVIDER_ERROR_PATTERN.test(message)
  ) {
    return true;
  }
  if (LONG_RETRY_AFTER_PATTERN.test(message)) {
    return true;
  }
  const hasShortWindowSignal = SHORT_WINDOW_RATE_LIMIT_PATTERN.test(message);
  return LONG_WINDOW_RATE_LIMIT_PATTERN.test(message) && !hasShortWindowSignal;
}

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  if (isNonRetryableAssistantErrorText(message.errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}
