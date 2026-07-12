import type { AssistantMessage } from "../types.js";
import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "daily (?:request|usage) limit",
  "requests? per day",
  "available balance",
  "insufficient_quota",
  "out of budget",
  "retry after\\s+\\d+\\s*(?:h|hours?|d|days?)",
]);

const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded",
  "rate.?limit",
  "too many requests",
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
  const errorMessage = message.errorMessage.trim();
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) {
    return false;
  }
  const status = extractLeadingHttpStatus(errorMessage)?.code;
  if (status && RETRYABLE_HTTP_STATUS_CODES.has(status)) {
    return true;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
