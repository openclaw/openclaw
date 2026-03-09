/**
 * Centralized relative-time formatting utilities.
 *
 * Consolidates 7+ scattered implementations (formatAge, formatAgeShort, formatAgo,
 * formatRelativeTime, formatElapsedTime) into two functions:
 *
 * - `formatTimeAgo(durationMs)` — format a duration as "5m ago" / "5m" (for known elapsed time)
 * - `formatRelativeTimestamp(epochMs)` — format an epoch timestamp relative to now (handles future)
 */

export type FormatTimeAgoOptions = {
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
  if (minutes < 60) {
    return suffix ? `${minutes}m ago` : `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return suffix ? `${hours}h ago` : `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return suffix ? `${days}d ago` : `${days}d`;
}

export type FormatRelativeTimestampOptions = {
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

  const sec = Math.round(absDiff / 1000);
  if (sec < 60) {
    return isPast ? "just now" : "in <1m";
  }

  const min = Math.round(sec / 60);
  if (min < 60) {
    return isPast ? `${min}m ago` : `in ${min}m`;
  }

  const hr = Math.round(min / 60);
  if (hr < 48) {
    return isPast ? `${hr}h ago` : `in ${hr}h`;
  }

  const day = Math.round(hr / 24);
  if (!options?.dateFallback || day <= 7) {
    return isPast ? `${day}d ago` : `in ${day}d`;
  }

  // Fall back to short date display for old timestamps
  try {
    const tsDate = new Date(timestampMs);
    const nowDate = new Date();
    const includeYear = tsDate.getFullYear() !== nowDate.getFullYear();
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
      ...(options.timezone ? { timeZone: options.timezone } : {}),
    }).format(tsDate);
  } catch {
    return `${day}d ago`;
  }
}

export type TemporalBucketOptions = {
  /** IANA timezone for date comparison. Uses system default if omitted. */
  timezone?: string;
  /** Override "now" for testing */
  now?: number;
};

/**
 * Categorize a timestamp into a temporal bucket for grouping.
 *
 * Returns one of:
 * - "Today"
 * - "Yesterday"
 * - "Last 7 days"
 * - "Last 30 days"
 * - "February 2026" (month + year for older in current year)
 * - "2025" (just year for previous years)
 */
export function getTemporalBucket(
  timestampMs: number | null | undefined,
  options?: TemporalBucketOptions,
): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return "Unknown";
  }

  const now = options?.now ?? Date.now();
  const tz = options?.timezone;

  // Get calendar dates in the target timezone
  const formatOpts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  };
  const fmt = new Intl.DateTimeFormat("en-CA", formatOpts); // en-CA gives YYYY-MM-DD
  const nowDateStr = fmt.format(new Date(now));
  const tsDateStr = fmt.format(new Date(timestampMs));

  // Same calendar day = Today
  if (tsDateStr === nowDateStr) {
    return "Today";
  }

  // Yesterday: subtract 1 day from now
  const yesterdayMs = now - 86400000;
  const yesterdayStr = fmt.format(new Date(yesterdayMs));
  if (tsDateStr === yesterdayStr) {
    return "Yesterday";
  }

  const diffDays = Math.floor((now - timestampMs) / 86400000);

  if (diffDays < 7) {
    return "Last 7 days";
  }

  if (diffDays < 30) {
    return "Last 30 days";
  }

  // Older: group by month+year or just year
  const tsDate = new Date(timestampMs);

  const tsYear = parseInt(tsDateStr.slice(0, 4), 10);
  const nowYear = parseInt(nowDateStr.slice(0, 4), 10);

  if (tsYear !== nowYear) {
    return String(tsYear);
  }

  // Same year but >30 days: show month + year
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      ...(tz ? { timeZone: tz } : {}),
    }).format(tsDate);
  } catch {
    return String(tsYear);
  }
}
