import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionTranscriptEventTimeRange = {
  startMs?: number;
  endMs?: number;
};

/** A malformed or untimestamped message must not be used as proof of exclusion. */
export function transcriptEventJsonMayOverlapRange(
  eventJson: string,
  range: SessionTranscriptEventTimeRange,
): boolean {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return true;
  }
  if (!isRecord(event)) {
    return true;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message) {
    return false; // The usage-cost parser cannot count session headers or control records.
  }
  // Match usage-cost parsing: only a finite numeric message timestamp in Date's
  // range takes priority; otherwise use a valid top-level timestamp string.
  const messageTimestamp = asFiniteNumber(message.timestamp);
  const parsedMessageTimestamp =
    messageTimestamp === undefined ? undefined : new Date(messageTimestamp).valueOf();
  const timestamp =
    parsedMessageTimestamp !== undefined && !Number.isNaN(parsedMessageTimestamp)
      ? parsedMessageTimestamp
      : typeof event.timestamp === "string"
        ? Date.parse(event.timestamp)
        : undefined;
  if (timestamp === undefined || Number.isNaN(timestamp)) {
    return true;
  }
  return (
    (range.startMs === undefined || timestamp >= range.startMs) &&
    (range.endMs === undefined || timestamp <= range.endMs)
  );
}

/** Metadata is only a safe fast-path to inclusion, never proof that content is out of range. */
export function transcriptMetadataMayOverlapRange(
  updatedAtMs: number | null | undefined,
  range: SessionTranscriptEventTimeRange,
): boolean {
  if (updatedAtMs === undefined || updatedAtMs === null || !Number.isFinite(updatedAtMs)) {
    return false;
  }
  return (
    (range.startMs === undefined || updatedAtMs >= range.startMs) &&
    (range.endMs === undefined || updatedAtMs <= range.endMs)
  );
}
