// Shared provider rate-limit window classification: the single source of truth
// for separating short-window (minute-scale, retryable) rate limits from
// long-window (daily/weekly/monthly/quota or multi-hour Retry-After) limits that
// a short exponential backoff cannot clear. Consumed by the embedded-agent
// failover path (same-model rate-limit retry) and the session-level auto-retry
// classifier so both paths agree on window semantics. (issue #102250)
import { extractLeadingHttpStatus } from "./assistant-error-format.js";

export type ShortWindowRateLimitRetry = {
  retryAfterSeconds?: number;
};

const LONG_WINDOW_RATE_LIMIT_RE =
  /\b(?:daily|weekly|monthly|tokens per day|requests per day|usage limit|subscription|insufficient[_ -]?quota|current quota|quota[_ -]?exceeded|quota exceeded)\b/i;
const SHORT_RATE_LIMIT_WINDOW_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm)\b/i;
const SHORT_WINDOW_RATE_LIMIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm|model_cooldown)\b|请求过于频繁|调用频率|频率限制/i;
const RETRY_AFTER_VALUE_RE = /\bretry[- ]after\b\s*:?\s*(?:in\s*)?([^\r\n;]+)/i;
const RETRY_AFTER_SECONDS_RE =
  /^(\d+(?:\.\d+)?)(?:\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m))?\b/i;
const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;
const RATE_LIMIT_HINT_RE = /\brate.?limit\b|\btoo many requests\b/i;

function parseRetryAfterSeconds(message: string): number | null {
  const valueText = RETRY_AFTER_VALUE_RE.exec(message)?.[1]?.trim();
  if (!valueText) {
    return null;
  }
  const secondsMatch = RETRY_AFTER_SECONDS_RE.exec(valueText);
  if (secondsMatch?.[1]) {
    const value = Number(secondsMatch[1]);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    const unit = secondsMatch[2]?.toLowerCase();
    if (
      unit?.startsWith("m") &&
      unit !== "ms" &&
      !unit.startsWith("msec") &&
      !unit.startsWith("millisecond")
    ) {
      return value * 60;
    }
    if (unit === "ms" || unit?.startsWith("msec") || unit?.startsWith("millisecond")) {
      return value / 1000;
    }
    return value;
  }
  const retryAtMs = Date.parse(valueText);
  if (!Number.isFinite(retryAtMs)) {
    return null;
  }
  return Math.max(0, (retryAtMs - Date.now()) / 1000);
}

export function resolveShortWindowRateLimitRetry(
  message: string | undefined,
): ShortWindowRateLimitRetry | null {
  const raw = message?.trim();
  if (!raw) {
    return null;
  }
  const retryAfterSeconds = parseRetryAfterSeconds(raw);
  if (retryAfterSeconds !== null && retryAfterSeconds > MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS) {
    return null;
  }
  const shortRetryAfter =
    retryAfterSeconds !== null && retryAfterSeconds <= MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS;
  const hasShortWindowSignal = SHORT_RATE_LIMIT_WINDOW_RE.test(raw);
  if (RETRY_AFTER_VALUE_RE.test(raw) && retryAfterSeconds === null && !hasShortWindowSignal) {
    return null;
  }
  if (LONG_WINDOW_RATE_LIMIT_RE.test(raw) && !hasShortWindowSignal && !shortRetryAfter) {
    return null;
  }
  // Providers such as Gemini use quota wording for per-minute RPM/TPM
  // throttles. Treat quota as long-window only when no short-window hint is
  // present; hard daily/usage/subscription limits are filtered above.
  // Some gateways strip throttle details and Retry-After. Preserve the
  // long-window exclusions above before treating a bare 429 as transient.
  const statusPrefixed429 = extractLeadingHttpStatus(raw)?.code === 429;
  if (!SHORT_WINDOW_RATE_LIMIT_RE.test(raw) && !shortRetryAfter && !statusPrefixed429) {
    return null;
  }
  return retryAfterSeconds !== null ? { retryAfterSeconds } : {};
}

export function isShortWindowRateLimitMessage(message: string | undefined): boolean {
  return resolveShortWindowRateLimitRetry(message) !== null;
}

/**
 * True when a rate-limit error's reset horizon (daily/weekly/monthly/quota, or
 * an unparseable / multi-hour Retry-After) exceeds what a short exponential
 * backoff can clear. Returns false for non-rate-limit errors so callers only
 * suppress retries on genuine rate limits, and defers to the short-window policy
 * above so session and embedded paths classify the same message identically.
 */
export function isLongWindowRateLimitMessage(message: string | undefined): boolean {
  const raw = message?.trim();
  if (!raw) {
    return false;
  }
  const isRateLimit =
    LONG_WINDOW_RATE_LIMIT_RE.test(raw) ||
    RATE_LIMIT_HINT_RE.test(raw) ||
    extractLeadingHttpStatus(raw)?.code === 429;
  if (!isRateLimit) {
    return false;
  }
  return !isShortWindowRateLimitMessage(raw);
}
