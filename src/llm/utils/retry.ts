import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";
import { isLongWindowRateLimitMessage } from "../../shared/rate-limit-window.js";
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
  "service.?unavailable",
  "bad gateway",
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

// A leading HTTP status is retryable only for transient server/throttle codes:
// request-timeout (408), too-early (425), too-many-requests (429), and any 5xx
// (server/gateway/overloaded/Cloudflare). Every other status — the permanent
// 4xx family (400/401/403/404/422 …) — fails fast.
function isRetryableHttpStatus(code: number): boolean {
  if (code === 408 || code === 425 || code === 429) {
    return true;
  }
  return code >= 500 && code <= 599;
}

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  const errorText = message.errorMessage;
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorText)) {
    return false;
  }
  // Long-window rate limits (daily/weekly/monthly/quota or a multi-hour
  // Retry-After) cannot clear within the session's short exponential backoff, so
  // retrying only re-sends context and re-bills. Defer to the shared window
  // policy the embedded-agent failover path also uses, so both classify the same
  // message identically. (issue #102250)
  if (isLongWindowRateLimitMessage(errorText)) {
    return false;
  }
  // Prefer structured status classification over substring matching: a leading
  // status code is authoritative, so permanent 4xx errors fail fast and a bare
  // number embedded in prose (e.g. "maximum width is 500 pixels", a model id, or
  // an API key) is never mistaken for a 5xx and retried. (issue #102250)
  const status = extractLeadingHttpStatus(errorText);
  if (status) {
    return isRetryableHttpStatus(status.code);
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorText);
}
