import { isImageDimensionErrorMessage } from "../../agents/embedded-agent-helpers/errors.js";
import {
  isAuthPermanentErrorMessage,
  isPeriodicUsageLimitErrorMessage,
} from "../../agents/embedded-agent-helpers/failover-matches.js";
import { isModelNotFoundErrorMessage } from "../../agents/live-model-errors.js";
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
  String.raw`\b429\b`,
  String.raw`\b500\b`,
  String.raw`\b502\b`,
  String.raw`\b503\b`,
  String.raw`\b504\b`,
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

/**
 * Detect rate-limit messages whose reset window is too long for the session
 * auto-retry backoff (2s/4s/8s by default). Retrying a daily/weekly/hourly
 * limit inside a ~14s window just re-sends the full context uselessly.
 */
const LONG_RETRY_WINDOW_HINT_RE =
  /\b(?:retry|try again|please try again)(?:\s+(?:after|in))?\s+\d+\s*(?:hour|hours|h|day|days|d|week|weeks|w|month|months)\b/i;

/**
 * Detect periodic request limits ("daily request limit", "hourly usage limit")
 * that cannot clear within the short session auto-retry window.
 */
const PERIODIC_REQUEST_LIMIT_RE =
  /\b(?:daily|hourly|weekly|monthly)(?:\/(?:daily|hourly|weekly|monthly))*\s+(?:request\s+)?(?:usage\s+)?limit\b/i;

function hasLongRetryWindowHint(errorMessage: string): boolean {
  return LONG_RETRY_WINDOW_HINT_RE.test(errorMessage);
}

function hasPeriodicRequestLimitHint(errorMessage: string): boolean {
  return PERIODIC_REQUEST_LIMIT_RE.test(errorMessage);
}

/**
 * Detect permanent provider errors that should never be retried: revoked or
 * invalid credentials, missing models, image schema rejections, and periodic
 * usage limits. These fail identically on every retry and re-sending the full
 * turn context wastes tokens and latency.
 */
function isNonRetryablePermanentError(errorMessage: string): boolean {
  if (isAuthPermanentErrorMessage(errorMessage)) {
    return true;
  }
  if (isModelNotFoundErrorMessage(errorMessage)) {
    return true;
  }
  if (isImageDimensionErrorMessage(errorMessage)) {
    return true;
  }
  if (isPeriodicUsageLimitErrorMessage(errorMessage)) {
    return true;
  }
  if (hasPeriodicRequestLimitHint(errorMessage)) {
    return true;
  }
  if (hasLongRetryWindowHint(errorMessage)) {
    return true;
  }
  return false;
}

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message.errorMessage)) {
    return false;
  }
  if (isNonRetryablePermanentError(message.errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}
