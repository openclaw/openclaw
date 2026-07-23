import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import type { TranscriptsSummary } from "./summary.js";

type MeetingTranscriptsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "meeting_transcript_sessions" | "meeting_transcript_summaries" | "meeting_transcript_utterances"
>;

export type MeetingTranscriptSessionRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_sessions"]
>;
type MeetingTranscriptSummaryRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_summaries"]
>;
type MeetingTranscriptUtteranceRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_utterances"]
>;

export function meetingTranscriptDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MeetingTranscriptsDatabase>(db);
}

function parseOptionalJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export function sessionFromRow(row: MeetingTranscriptSessionRow): TranscriptSessionDescriptor {
  const source = parseOptionalJsonRecord(row.source_json);
  const metadata = parseOptionalJsonRecord(row.metadata_json);
  if (!source || typeof source.providerId !== "string") {
    throw new Error(`invalid meeting transcript source for ${row.session_id}`);
  }
  return {
    sessionId: row.session_id,
    source: source as TranscriptSessionDescriptor["source"],
    startedAt: row.started_at,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.stopped_at !== null ? { stoppedAt: row.stopped_at } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function utteranceFromRow(row: MeetingTranscriptUtteranceRow): TranscriptUtterance {
  const speaker =
    row.speaker_label !== null
      ? {
          label: row.speaker_label,
          ...(row.speaker_id !== null ? { id: row.speaker_id } : {}),
        }
      : undefined;
  const metadata = parseOptionalJsonRecord(row.metadata_json);
  return {
    sessionId: row.session_id,
    text: row.text,
    ...(row.utterance_id !== null ? { id: row.utterance_id } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(speaker ? { speaker } : {}),
    ...(row.final === null ? {} : { final: row.final === 1 }),
    ...(metadata ? { metadata } : {}),
  };
}

export function summaryFromRow(row: MeetingTranscriptSummaryRow): TranscriptsSummary | undefined {
  return row.summary_json ? (JSON.parse(row.summary_json) as TranscriptsSummary) : undefined;
}
