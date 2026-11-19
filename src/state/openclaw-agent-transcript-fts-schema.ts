import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { DEPLOYED_FTS_ROWS_SCHEMA } from "./openclaw-agent-transcript-fts-schema-source.js";

const RETIRED_FTS_ROWS = "session_transcript_fts_rows_legacy22";

/** Preserve the FTS content; replace only its old, possibly incomplete ownership projection. */
export function migrateDeployedTranscriptFtsRowsInTransaction(
  db: DatabaseSync,
  schemaSql: string,
): void {
  if (!db.isTransaction || db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 0) {
    throw new Error(
      "Transcript FTS migration requires an admitted transaction with foreign keys off",
    );
  }
  assertSqliteSchemaContains(db, "deployed transcript FTS ownership", DEPLOYED_FTS_ROWS_SCHEMA);
  const columns = db.prepare("PRAGMA table_xinfo(session_transcript_fts_rows)").all();
  if (
    columns.length !== 2 ||
    columns.some((column) => column.name !== "session_id" && column.name !== "fts_rowid")
  ) {
    throw new Error("Transcript FTS migration cannot discard unknown row-map columns");
  }
  const dependents = db
    .prepare(`SELECT name FROM sqlite_schema
    WHERE (tbl_name = 'session_transcript_fts_rows' AND sql IS NOT NULL
      AND type IN ('index', 'trigger') AND name != 'idx_agent_transcript_fts_rows_session')
      OR (type IN ('view', 'trigger') AND sql LIKE '%session_transcript_fts_rows%')`)
    .all();
  const children = db
    .prepare(`SELECT schema.name FROM sqlite_schema AS schema
    JOIN pragma_foreign_key_list(schema.name) AS fk
    WHERE schema.type = 'table' AND fk."table" = 'session_transcript_fts_rows'`)
    .all();
  if (dependents.length || children.length) {
    throw new Error("Transcript FTS migration cannot discard unknown row-map dependencies");
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(RETIRED_FTS_ROWS)) {
    throw new Error("Transcript FTS migration table already exists");
  }
  db.exec(`ALTER TABLE session_transcript_fts_rows RENAME TO ${RETIRED_FTS_ROWS}`);
  db.exec(
    extractSqliteTableSchema(schemaSql, "session_transcript_fts_rows", {
      endMarker: "INSERT OR IGNORE INTO memory_index_state",
      includeEndMarker: false,
    }),
  );
  // Copy in SQL: rowids may be negative or exceed JavaScript's exact integer range.
  db.exec(`INSERT INTO session_transcript_fts_rows (id, session_id, message_id)
    SELECT rowid, session_id, message_id FROM session_transcript_fts`);
  // The old lazy migration and interrupted claims can leave unknown or incomplete ownership.
  // Mark that work pending without changing its claim, cursor, or active-path facts.
  db.exec(`UPDATE session_transcript_index_state AS state SET needs_rebuild = 1
    WHERE needs_rebuild = 0 AND (
      fts_row_count IS NULL
      OR fts_row_count != (SELECT count(*) FROM ${RETIRED_FTS_ROWS} AS old WHERE old.session_id = state.session_id)
      OR EXISTS (
        SELECT 1 FROM ${RETIRED_FTS_ROWS} AS old
        WHERE old.session_id = state.session_id AND NOT EXISTS (
          SELECT 1 FROM session_transcript_fts_rows AS current
          WHERE current.id = old.fts_rowid AND current.session_id = old.session_id))
      OR EXISTS (
        SELECT 1 FROM session_transcript_fts_rows AS current
        WHERE current.session_id = state.session_id AND NOT EXISTS (
          SELECT 1 FROM ${RETIRED_FTS_ROWS} AS old
          WHERE old.fts_rowid = current.id AND old.session_id = current.session_id))
    );
    DROP TABLE ${RETIRED_FTS_ROWS};
    ALTER TABLE session_transcript_index_state DROP COLUMN fts_row_count;`);
}
