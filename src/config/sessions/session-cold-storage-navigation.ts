import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import { iterateSessionColdRecords } from "./session-cold-storage-chunks.js";
import { writeSessionColdRecordsInTransaction } from "./session-cold-storage-records.js";
import { deleteSessionTranscriptFtsRowsInTransaction } from "./session-transcript-fts.js";
import {
  reconcileSessionTranscriptIndexInTransaction,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { prepareColdTranscriptPayload, readTranscriptPayload } from "./transcript-payload.js";

type ColdDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

/** Archival keeps the SQL selector's identities and active path while dropping eligible bodies. */
export function retainSessionColdNavigationInTransaction(
  database: ColdDatabase,
  sessionId: string,
): void {
  // Historical archives can carry an unfinished projection. Qualify it while bodies are available.
  reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  const db = getNodeSqliteKysely<DB>(database.db);
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["seq", "event_json", "event_zstd", "event_utf8_bytes", "navigation_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq"),
  )) {
    const payload =
      row.navigation_json !== null
        ? { event_json: null, event_zstd: null }
        : prepareColdTranscriptPayload(database.db, readTranscriptPayload(row));
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_events")
        .set(payload)
        .where("session_id", "=", sessionId)
        .where("seq", "=", row.seq),
    );
  }
}

/** Doctor commits each verified archive independently; rollback leaves it eligible for retry. */
export function backfillSessionColdNavigationInTransaction(
  database: ColdDatabase,
  archive: Omit<SessionColdArchive, "archive_blob">,
): void {
  if (!database.db.isTransaction) {
    throw new Error("Cold navigation migration requires its owner's transaction");
  }
  writeSessionColdRecordsInTransaction(
    database,
    archive.session_id,
    iterateSessionColdRecords(database.db, database.path, archive),
    "navigation",
  );
  if (sessionTranscriptIndexNeedsReconcile(database.db, archive.session_id)) {
    // Older archives can lack a qualified index. Only that repair needs the canonical bodies.
    const db = getNodeSqliteKysely<DB>(database.db);
    const hydrate = prepareSqliteQuerySync<{ seq: number; event_json: string }>(
      database.db,
      (parameter) =>
        db
          .updateTable("transcript_events")
          .set({ event_json: parameter((row) => row.event_json) })
          .where("session_id", "=", archive.session_id)
          .where(
            "seq",
            "=",
            parameter((row) => row.seq),
          )
          .where("navigation_json", "is not", null),
    );
    for (const record of iterateSessionColdRecords(database.db, database.path, archive)) {
      if (record.kind === "event") {
        hydrate(record.row);
      }
    }
    reconcileSessionTranscriptIndexInTransaction(database.db, archive.session_id);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_events")
        .set({ event_json: null })
        .where("session_id", "=", archive.session_id)
        .where("navigation_json", "is not", null),
    );
  }
  deleteSessionTranscriptFtsRowsInTransaction(database.db, archive.session_id);
}
