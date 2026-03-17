/**
 * Injects a human-readable metadata annotation for images referenced in thread
 * history. This gives the model temporal and positional context to assess image
 * freshness relative to the current message in the conversation.
 *
 * Example annotation:
 *   [Image — sent Sat 3/16/2026, 10:50 AM EDT, message 2 of 8 in thread, from alice (user)]
 */

export interface ImageAnnotationOptions {
  /** Total number of messages in the thread. */
  totalMessages: number;
  /** 1-based index of this message in the thread. */
  messageIndex: number;
  /** Timestamp — Unix seconds (number or Slack decimal string) or ISO string. */
  timestamp?: number | string;
  /** Display name or identifier of the message author. */
  author?: string;
  /** IANA timezone string, e.g. "America/New_York". Falls back to UTC. */
  timezone?: string;
}

/**
 * Normalizes a raw timestamp value (Slack decimal-seconds string, Unix seconds
 * integer, Unix milliseconds integer, or ISO string) into a Date object.
 * Returns null for invalid or missing input.
 */
export function normalizeTimestamp(raw: number | string | undefined | null): Date | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    // Slack uses decimal-second strings like "1710590400.123456"
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      const date = new Date(parsed * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    // Try ISO 8601 / other parseable string formats
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return null;
    }
    // Heuristic: values > 1e12 are likely milliseconds, otherwise seconds
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Formats the metadata annotation line injected before image references in
 * thread history text.
 */
export function buildImageAnnotation(opts: ImageAnnotationOptions): string {
  const { totalMessages, messageIndex, timestamp, author, timezone = "UTC" } = opts;

  const date = normalizeTimestamp(timestamp);

  let timeStr = "unknown time";
  if (date) {
    try {
      timeStr = date.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
    } catch {
      // Invalid timezone — fall back to UTC
      try {
        timeStr = date.toLocaleString("en-US", {
          timeZone: "UTC",
          weekday: "short",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        });
      } catch {
        timeStr = "unknown time";
      }
    }
  }

  const positionStr =
    totalMessages === 1
      ? "standalone message"
      : `message ${messageIndex} of ${totalMessages} in thread`;

  const authorStr = author?.trim() ? `, from ${author.trim()}` : "";

  return `[Image — sent ${timeStr}, ${positionStr}${authorStr}]`;
}
