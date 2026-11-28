import { iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createTranscriptSpeakerLabels } from "./speaker-labels.js";
import { meetingTranscriptDb, meetingTranscriptUtteranceQuery } from "./store-sqlite.js";
import type { TranscriptSessionDescriptor } from "./types.js";

function transcriptSpeakerObservationRows(
  utterances: ReturnType<typeof meetingTranscriptUtteranceQuery>,
) {
  return utterances
    .select(["speaker_id", "speaker_label"])
    .select((u) => u.fn.min<number>("sequence").as("first_sequence"))
    .where("speaker_label", "is not", null)
    .where("speaker_label", "!=", "")
    .groupBy(["speaker_id", "speaker_label"])
    .orderBy((u) => u.fn.min("sequence"), "asc");
}

type TranscriptSpeakerRosterRow = {
  speaker_key: number | null;
  speaker_label: string | null;
};

export function transcriptSpeakerRosterRows(
  database: EngineConnection,
  utterances: ReturnType<typeof meetingTranscriptUtteranceQuery>,
) {
  const groups = transcriptSpeakerObservationRows(utterances);
  return meetingTranscriptDb(database)
    .selectFrom(groups.as("speaker_groups"))
    .select(["speaker_label", "first_sequence"])
    .select((eb) =>
      eb
        .case()
        .when("speaker_id", "is", null)
        .then(eb.val(null))
        .when("speaker_id", "=", "")
        .then(eb.val(null))
        .else(
          eb.fn.min<number>("first_sequence").over((window) => window.partitionBy("speaker_id")),
        )
        .end()
        .as("speaker_key"),
    )
    .orderBy("first_sequence", "asc");
}

/**
 * Streams first-seen label variants in session order. The resolver keeps the
 * first usable label per source identity, so SQL never reimplements terminal
 * text sanitation.
 * Resolver state is proportional to distinct source identities/display labels,
 * never transcript speech bytes or a materialized roster payload.
 */
export function iterateTranscriptSpeakerObservations(
  database: EngineConnection,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  beforeSequence: number,
) {
  return iterateSqliteQuerySync(
    database,
    transcriptSpeakerObservationRows(
      meetingTranscriptUtteranceQuery(database, session).where("sequence", "<", beforeSequence),
    ),
  );
}

export function transcriptParticipants(value: string | null): string[] {
  // SAFETY: readQuery serializes only the typed columns from transcriptSpeakerRosterRows.
  const observations = JSON.parse(value ?? "[]") as TranscriptSpeakerRosterRow[];
  const label = createTranscriptSpeakerLabels();
  const participants = new Set<string>();
  for (const observation of observations) {
    const participant = label(
      observation.speaker_key === null ? undefined : String(observation.speaker_key),
      observation.speaker_label,
    );
    if (participant) {
      participants.add(participant);
    }
  }
  return [...participants];
}
