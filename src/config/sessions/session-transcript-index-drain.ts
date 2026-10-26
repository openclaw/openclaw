import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "./session-transcript-index.js";

type TranscriptIndexDrainDatabase = Pick<
  DB,
  "session_transcript_active_events" | "session_transcript_fts_rows"
> & { session_transcript_fts: { rowid: number; text: string | null } };

/**
 * Delete one session's FTS rows within a row and text-byte budget. Each FTS delete re-tokenizes
 * its stored text, so bytes bound the native cost; the first row is always taken.
 */
function deleteSessionTranscriptFtsRowsWithinBudget(
  db: EngineConnection,
  sessionId: string,
  budget: { maxRows: number; maxBytes: number },
): { deletedRows: number; exhausted: boolean } {
  const kysely = getNodeSqliteKysely<TranscriptIndexDrainDatabase>(db);
  const candidates = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_transcript_fts_rows as row")
      .leftJoin("session_transcript_fts as fts", "fts.rowid", "row.id")
      .select(["row.id", sql<number | null>`octet_length(fts.text)`.as("bytes")])
      .where("row.session_id", "=", sessionId)
      // Any order drains a dirty projection; ordering by id would sort every remaining row.
      .limit(budget.maxRows + 1),
  ).rows;
  const ids: number[] = [];
  let bytes = 0;
  for (const candidate of candidates.slice(0, budget.maxRows)) {
    bytes += candidate.bytes ?? 0;
    if (ids.length > 0 && bytes > budget.maxBytes) {
      break;
    }
    ids.push(candidate.id);
  }
  if (ids.length > 0) {
    withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () =>
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("session_transcript_fts_rows").where("id", "in", ids),
      ),
    );
  }
  return { deletedRows: ids.length, exhausted: ids.length === candidates.length };
}

/**
 * Drains one bounded batch of a doomed session's derived projection ahead of its deletion
 * transaction. Dirty state lands first, so readers fall back to canonical rows and a refused
 * deletion is rebuilt by reconcile; canonical transcript rows are never touched here.
 */
export function drainSessionTranscriptIndexInTransaction(
  db: EngineConnection,
  sessionId: string,
  budget: { maxRows: number; maxBytes: number },
): { deletedRows: number; exhausted: boolean } {
  markSessionTranscriptIndexDirtyInTransaction(db, sessionId);
  const fts = deleteSessionTranscriptFtsRowsWithinBudget(db, sessionId, budget);
  const activeBudget = budget.maxRows - fts.deletedRows;
  if (!fts.exhausted || activeBudget <= 0) {
    return { deletedRows: fts.deletedRows, exhausted: false };
  }
  const kysely = getNodeSqliteKysely<TranscriptIndexDrainDatabase>(db);
  const active = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_transcript_active_events")
      .select("active_position")
      .where("session_id", "=", sessionId)
      .orderBy("active_position")
      .limit(activeBudget + 1),
  ).rows.map((row) => row.active_position);
  const deleted = active.slice(0, activeBudget);
  if (deleted.length > 0) {
    withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () =>
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_transcript_active_events")
          .where("session_id", "=", sessionId)
          .where("active_position", "in", deleted),
      ),
    );
  }
  return {
    deletedRows: fts.deletedRows + deleted.length,
    exhausted: deleted.length === active.length,
  };
}
