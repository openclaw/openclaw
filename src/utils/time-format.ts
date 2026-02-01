/**
 * Formats a timestamp into a human-readable relative time string.
 *
 * Returns relative time descriptions like "just now", "5m ago", "2h ago",
 * "Yesterday", or "3d ago" for recent times. For timestamps older than 7 days,
 * returns a formatted date string (e.g., "Jan 24").
 *
 * @param timestamp - The timestamp to format (in milliseconds since Unix epoch)
 * @returns A human-readable relative time string
 *
 * @example
 * formatRelativeTime(Date.now() - 30000) // returns "just now"
 * formatRelativeTime(Date.now() - 300000) // returns "5m ago"
 * formatRelativeTime(Date.now() - 7200000) // returns "2h ago"
 * formatRelativeTime(Date.now() - 86400000) // returns "Yesterday"
 * formatRelativeTime(Date.now() - 172800000) // returns "2d ago"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
