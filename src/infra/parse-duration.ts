/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported formats:
 *   - "30m"  → 1_800_000 (30 minutes)
 *   - "1h"   → 3_600_000 (1 hour)
 *   - "4h"   → 14_400_000 (4 hours)
 *   - "24h"  → 86_400_000 (24 hours)
 *   - "90s"  → 90_000 (90 seconds)
 *
 * Returns null for unrecognised input.
 */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) {
    return null;
  }
  const n = parseFloat(match[1]);
  if (!isFinite(n) || n <= 0) {
    return null;
  }
  switch (match[2]) {
    case "s":
      return Math.round(n * 1_000);
    case "m":
      return Math.round(n * 60_000);
    case "h":
      return Math.round(n * 3_600_000);
    case "d":
      return Math.round(n * 86_400_000);
    default:
      return null;
  }
}

/**
 * Format a duration in ms as a human-readable "Xm" / "Xh Ym" string for display.
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
