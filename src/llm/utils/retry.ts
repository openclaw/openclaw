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

const RETRY_AFTER_VALUE_PATTERN = /\bretry[- ]after\b\s*:?\s*(?:in\s*)?([^\r\n;]+)/i;
const RETRY_AFTER_DELAY_PATTERN =
  /^(\d+(?:\.\d+)?)(?:\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d))?\b/i;
const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;

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

function parseRetryAfterSeconds(message: string): number | null {
  const valueText = RETRY_AFTER_VALUE_PATTERN.exec(message)?.[1]?.trim();
  if (!valueText) {
    return null;
  }
  const delayMatch = RETRY_AFTER_DELAY_PATTERN.exec(valueText);
  if (delayMatch?.[1]) {
    const value = Number(delayMatch[1]);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    const unit = delayMatch[2]?.toLowerCase();
    if (unit === "ms" || unit?.startsWith("msec") || unit?.startsWith("millisecond")) {
      return value / 1000;
    }
    if (unit?.startsWith("h")) {
      return value * 60 * 60;
    }
    if (unit?.startsWith("d")) {
      return value * 60 * 60 * 24;
    }
    if (unit?.startsWith("m")) {
      return value * 60;
    }
    return value;
  }
  const retryAtMs = Date.parse(valueText);
  if (!Number.isFinite(retryAtMs)) {
    return null;
  }
  return Math.max(0, (retryAtMs - Date.now()) / 1000);
}

function isNonRetryableAssistantErrorText(message: string): boolean {
  if (
    NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message) ||
    PERMANENT_PROVIDER_ERROR_PATTERN.test(message)
  ) {
    return true;
  }
  const retryAfterSeconds = parseRetryAfterSeconds(message);
  if (retryAfterSeconds !== null && retryAfterSeconds > MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS) {
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
