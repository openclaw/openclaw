import { formatRelativeTimestamp } from "../infra/format-time/format-relative.ts";

/** Delegates to centralized formatRelativeTimestamp with date fallback for >7d. */
export function formatRelativeTime(timestamp: number): string {
  return formatRelativeTimestamp(timestamp, { dateFallback: true, fallback: "unknown" });
}
