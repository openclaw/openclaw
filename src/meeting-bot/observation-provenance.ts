import type { MeetingParticipationSource } from "./participation-types.js";
import {
  meetingObservationProvenanceSchema,
  type MeetingObservationProvenance,
  type MeetingTranscriptLine,
  type MeetingTranscriptSnapshot,
} from "./session-types.js";

/** Decode only bounded scalar facts. Invalid envelopes cannot donate identity or self claims. */
export function normalizeMeetingObservationProvenance(
  value: unknown,
  fallback: { observer: string; epoch?: unknown; observedAt?: unknown; speaker?: unknown },
): MeetingObservationProvenance {
  const parsed = meetingObservationProvenanceSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const fields = meetingObservationProvenanceSchema.shape;
  const observer = fields.observer.safeParse(fallback.observer);
  const epoch = fields.epoch.unwrap().safeParse(fallback.epoch);
  const observedAt = fields.observedAt.unwrap().safeParse(fallback.observedAt);
  const speaker = fields.speaker.unwrap().safeParse(fallback.speaker);
  return {
    observer: observer.success ? observer.data : "unknown",
    ...(epoch.success ? { epoch: epoch.data } : {}),
    ...(observedAt.success ? { observedAt: observedAt.data } : {}),
    ...(speaker.success ? { speaker: speaker.data } : {}),
    self: "unknown",
  };
}

/** Keep optional legacy shapes, but never share a mutable envelope with its caller. */
export function snapshotMeetingObservation<T extends { provenance?: MeetingObservationProvenance }>(
  value: T,
): T {
  return {
    ...value,
    ...(value.provenance !== undefined
      ? {
          provenance: normalizeMeetingObservationProvenance(value.provenance, {
            observer: "unknown",
          }),
        }
      : {}),
  };
}

export function snapshotMeetingTranscript<
  T extends { lines?: MeetingTranscriptLine[]; pendingLines?: MeetingTranscriptLine[] },
>(snapshot: T): T {
  return {
    ...snapshot,
    ...(snapshot.lines ? { lines: snapshot.lines.map(snapshotMeetingObservation) } : {}),
    ...(snapshot.pendingLines
      ? { pendingLines: snapshot.pendingLines.map(snapshotMeetingObservation) }
      : {}),
  };
}

/** Carry row facts only where an independently validated action-source identity exists. */
export function meetingCaptionParticipationSources(
  snapshot: MeetingTranscriptSnapshot,
): MeetingParticipationSource[] {
  return [...snapshot.lines, ...(snapshot.pendingLines ?? [])].flatMap<MeetingParticipationSource>(
    (line) =>
      line.source
        ? [
            {
              ...line.source,
              kind: "caption",
              text: line.text,
              ...(line.provenance ? { provenance: line.provenance } : {}),
            },
          ]
        : [],
  );
}
