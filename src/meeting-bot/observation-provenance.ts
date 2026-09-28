import { z } from "zod";
import type { MeetingParticipationSource } from "./participation-types.js";
import type {
  MeetingObservationProvenance,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const observerSchema = boundedText(128);
const identitySchema = boundedText(512);
const speakerSchema = boundedText(512);
const observedAtSchema = z.iso.datetime({ offset: true }).max(64);
const provenanceSchema = z.object({
  observer: observerSchema,
  observationId: boundedText(1_024).optional(),
  sessionId: identitySchema.optional(),
  epoch: identitySchema.optional(),
  observedAt: observedAtSchema.optional(),
  speaker: speakerSchema.optional(),
  self: z.enum(["self", "other", "unknown"]),
});

/** Decode only bounded scalar facts. Invalid envelopes cannot donate identity or self claims. */
export function normalizeMeetingObservationProvenance(
  value: unknown,
  fallback: { observer: string; epoch?: unknown; observedAt?: unknown; speaker?: unknown },
): MeetingObservationProvenance {
  const parsed = provenanceSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const observer = observerSchema.safeParse(fallback.observer);
  const epoch = identitySchema.safeParse(fallback.epoch);
  const observedAt = observedAtSchema.safeParse(fallback.observedAt);
  const speaker = speakerSchema.safeParse(fallback.speaker);
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
