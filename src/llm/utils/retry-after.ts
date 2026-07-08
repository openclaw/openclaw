const RETRY_AFTER_VALUE_PATTERN = /\bretry[- ]after\b\s*:?\s*(?:in\s*)?([^\r\n;]+)/i;
const RETRY_AFTER_DELAY_PATTERN =
  /^(-?\d+(?:\.\d+)?)(?:\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d))?\b/i;

export const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;

export function hasRetryAfterValue(message: string): boolean {
  return RETRY_AFTER_VALUE_PATTERN.test(message);
}

export function parseRetryAfterSeconds(message: string): number | null {
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
