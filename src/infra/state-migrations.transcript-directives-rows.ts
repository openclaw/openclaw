import type { DatabaseSync } from "node:sqlite";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  parseDirectiveMigrationTranscriptEvent,
  transformHistoricalTranscriptEvent,
} from "./state-migrations.transcript-directives-transform.js";

const TRANSCRIPT_REPAIR_BATCH_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_REPAIR_BATCH_ROWS = 64;

type TranscriptRowPlan = { eventJson: string; rewrittenEventJson: string; seq: number };
export type TranscriptSessionPlan = {
  rows: TranscriptRowPlan[];
  afterSeq: number | undefined;
  throughSeq: number | undefined;
  complete: boolean;
};

export function listTranscriptCandidateSessions(database: DatabaseSync, afterSessionId: string) {
  const db = getNodeSqliteKysely<DB>(database);
  const sessions = new Set<string>();
  // Return every evaluated row to JS: a decoded WHERE can retain all native
  // decoder allocations in one step, even when iterate() returns no matches.
  for (const row of iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        "session_id",
        eb(transcriptEventJsonSql(database), "like", "%[[%").as("candidate"),
      ]),
  )) {
    if (row.candidate && row.session_id > afterSessionId) {
      sessions.add(row.session_id);
    }
  }
  return [...sessions].toSorted();
}

function readTranscriptSessionRows(
  database: DatabaseSync,
  sessionId: string,
  afterSeq?: number,
  throughSeq?: number,
) {
  const db = getNodeSqliteKysely<DB>(database);
  return iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        "seq",
        eb
          .case()
          .when(transcriptEventJsonSql(database), "like", "%[[%")
          .then(transcriptEventJsonSql(database))
          .else(null)
          .end()
          .as("event_json"),
      ])
      .where("session_id", "=", sessionId)
      .$if(afterSeq !== undefined, (query) => query.where("seq", ">", afterSeq!))
      .$if(throughSeq !== undefined, (query) => query.where("seq", "<=", throughSeq!))
      .orderBy("seq", "asc"),
  );
}

export function* planTranscriptSession(
  database: DatabaseSync,
  pathname: string,
  sessionId: string,
): Generator<TranscriptSessionPlan> {
  let rows: TranscriptRowPlan[] = [];
  let bytes = 0;
  let afterSeq: number | undefined;
  let throughSeq: number | undefined;
  for (const row of readTranscriptSessionRows(database, sessionId)) {
    if (row.event_json !== null) {
      const event = parseDirectiveMigrationTranscriptEvent(
        row.event_json,
        `${pathname}:${sessionId}:${row.seq}`,
      );
      const transformed = transformHistoricalTranscriptEvent(event);
      const rewrittenEventJson = transformed.changed
        ? JSON.stringify(transformed.event)
        : row.event_json;
      const rowBytes = Buffer.byteLength(row.event_json) + Buffer.byteLength(rewrittenEventJson);
      if (rows.length > 0 && bytes + rowBytes > TRANSCRIPT_REPAIR_BATCH_BYTES) {
        yield { rows, afterSeq, throughSeq, complete: false };
        afterSeq = throughSeq;
        rows = [];
        bytes = 0;
      }
      rows.push({ eventJson: row.event_json, rewrittenEventJson, seq: row.seq });
      bytes += rowBytes;
    }
    throughSeq = row.seq;
    if (rows.length >= TRANSCRIPT_REPAIR_BATCH_ROWS || bytes >= TRANSCRIPT_REPAIR_BATCH_BYTES) {
      yield { rows, afterSeq, throughSeq, complete: false };
      afterSeq = throughSeq;
      rows = [];
      bytes = 0;
    }
  }
  // The final transaction checks the remaining range and advances the cursor,
  // including sessions whose last repair filled a batch exactly.
  yield { rows, afterSeq, throughSeq: undefined, complete: true };
}

export function assertTranscriptSessionSourceUnchanged(
  database: DatabaseSync,
  sessionId: string,
  planned: TranscriptSessionPlan,
): void {
  let index = 0;
  for (const row of readTranscriptSessionRows(
    database,
    sessionId,
    planned.afterSeq,
    planned.throughSeq,
  )) {
    if (row.event_json === null) {
      continue;
    }
    const expected = planned.rows[index++];
    if (row.seq !== expected?.seq || row.event_json !== expected.eventJson) {
      throw new Error("Transcript source changed before migration commit for " + sessionId);
    }
  }
  if (index !== planned.rows.length) {
    throw new Error("Transcript source changed before migration commit for " + sessionId);
  }
}
