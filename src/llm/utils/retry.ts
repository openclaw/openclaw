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
  // Long-window rate limits (daily/multi-hour reset). The outer retry budget is
  // a handful of sub-15s exponential backoffs, which can never clear a window
  // measured in hours or days — retrying only re-sends the full context and
  // re-bills tokens. Matched here so they short-circuit the retryable "rate
  // limit"/"429" patterns below. (issue #102250)
  "per day",
  "daily.{0,40}limit",
  "try again in \\d+\\s*(?:hour|hours|day|days)",
  "retry after \\d+\\s*(?:h(?:ours?)?|d(?:ays?)?)\\b",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded",
  "rate.?limit",
  "too many requests",
  // Anchor bare HTTP status tokens on word boundaries so they only match a
  // standalone status code, not a digit run embedded in a model id, image
  // dimension, request id, or API key (e.g. "…preview-0429", "1504x1504",
  // "sk-proj-abc502xyz"). Unanchored, those substrings made permanent 400/401/
  // 404 errors look retryable, burning tokens on doomed re-sends. (issue #102250)
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
