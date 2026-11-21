import type { DatabaseSync } from "node:sqlite";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** The caller owns the schema transaction; legacy local dates freeze its timezone once. */
export function migrateMeetingTranscriptStartTime(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (
    previousVersion >= MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION ||
    !tableExists(db, "meeting_transcript_sessions")
  ) {
    return false;
  }
  let changed = ensureColumn(db, "meeting_transcript_sessions", "started_at_ms INTEGER");
  const rows = iterateSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at"]),
  );
  const update = db.prepare(
    "UPDATE meeting_transcript_sessions SET started_at_ms = ? WHERE session_id = ? AND started_at = ?",
  );
  for (const row of rows) {
    update.run(parseDateStringTimestampMs(row.started_at) ?? null, row.session_id, row.started_at);
    changed = true;
  }
  return changed;
}
