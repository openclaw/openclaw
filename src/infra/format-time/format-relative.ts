import { bucketRelativeTimeMs } from "@openclaw/normalization-core";

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
  options?: {
    /** Append "ago" suffix. Default: true. When false, returns bare unit: "5m", "2h" */
    suffix?: boolean;
    /** Return value for invalid/null/negative input. Default: "unknown" */
    fallback?: string;
  },
): string {
  const suffix = options?.suffix !== false;
  const fallback = options?.fallback ?? "unknown";

  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const minutes = Math.round(durationMs / 60_000);

  if (minutes < 1) {
    return suffix ? "just now" : `${Math.round(durationMs / 1000)}s`;
  }
  const { value, unit } = bucketRelativeTimeMs(durationMs);
  // CLI ages promote to minutes before the localized timestamp's sub-minute cutoff.
  const label = unit === "second" ? `${minutes}m` : `${value}${unit[0]}`;
  return suffix ? `${label} ago` : label;
}

/**
 * Format an epoch timestamp relative to now.
 *
 * Handles both past ("5m ago") and future ("in 5m") timestamps.
 * Falls back to a short date for timestamps older than 7 days.
 */
export function formatRelativeTimestamp(timestampMs: number | null | undefined): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return "";
  }

  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;

  const { value, unit } = bucketRelativeTimeMs(absDiff);
  if (unit === "second") {
    return isPast ? "just now" : "in <1m";
  }
  const relative = isPast ? `${value}${unit[0]} ago` : `in ${value}${unit[0]}`;
  if (unit !== "day" || value <= 7) {
    return relative;
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date(timestampMs));
  } catch {
    return relative;
  }
}
