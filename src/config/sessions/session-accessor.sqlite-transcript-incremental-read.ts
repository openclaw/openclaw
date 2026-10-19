import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptEventRow,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export function loadTranscriptEventRowsAfterSeqInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  afterSeq: number,
): SessionTranscriptEventRow[] {
  return readHotSessionTranscriptSnapshot(database, sessionId, "incremental", () => {
    const db = getSessionKysely(database.db);
    const query = db
      .selectFrom("transcript_events")
      .select([transcriptEventJsonSql(database.db).as("event_json"), "seq"])
      .where("session_id", "=", sessionId)
      .where("seq", ">", afterSeq);
    return executeSqliteQuerySync(database.db, query.orderBy("seq", "asc")).rows.map((row) => ({
      // SAFETY: Transcript writers persist TranscriptEvent JSON in the selected event column.
      event: JSON.parse(row.event_json) as TranscriptEvent,
      seq: sqliteNumber(row.seq),
    }));
  });
}
