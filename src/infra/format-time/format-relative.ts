import { bucketRelativeTimeMs } from "@openclaw/normalization-core";

type FormatTimeAgoOptions = {
  /** Append "ago" suffix. Default: true. When false, returns bare unit: "5m", "2h" */
  suffix?: boolean;
  /** Return value for invalid/null/negative input. Default: "unknown" */
  fallback?: string;
};

/**
 * Format a duration (in ms) as a human-readable relative time.
 *
 * Input: how many milliseconds ago something happened.
 *
 * With suffix (default):  "just now", "5m ago", "3h ago", "2d ago"
 * Without suffix:         "0s", "5m", "3h", "2d"
 */
export function formatTimeAgo(
  durationMs: number | null | undefined,
  options?: FormatTimeAgoOptions,
): string {
  const suffix = options?.suffix !== false;
  const fallback = options?.fallback ?? "unknown";

  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.round(totalSeconds / 60);

  if (minutes < 1) {
    return suffix ? "just now" : `${totalSeconds}s`;
  }
  const hours = Math.round(minutes / 60);
  const label =
    minutes < 60 ? `${minutes}m` : hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  return suffix ? `${label} ago` : label;
}

type FormatRelativeTimestampOptions = {
  /** If true, fall back to short date (e.g. "Oct 5") for timestamps >7 days. Default: false */
  dateFallback?: boolean;
  /** IANA timezone for date fallback display */
  timezone?: string;
  /** Return value for invalid/null input. Default: "n/a" */
  fallback?: string;
};

/**
 * Format an epoch timestamp relative to now.
 *
 * Handles both past ("5m ago") and future ("in 5m") timestamps.
 * Optionally falls back to a short date for timestamps older than 7 days.
 */
export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options?: FormatRelativeTimestampOptions,
): string {
  const fallback = options?.fallback ?? "n/a";
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;

  const { value, unit } = bucketRelativeTimeMs(absDiff);
  if (unit === "second") {
    return isPast ? "just now" : "in <1m";
  }
  const relative = isPast ? `${value}${unit[0]} ago` : `in ${value}${unit[0]}`;
  if (unit !== "day" || !options?.dateFallback || value <= 7) {
    return relative;
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(options.timezone ? { timeZone: options.timezone } : {}),
    }).format(new Date(timestampMs));
  } catch {
    return relative;
  }
}
