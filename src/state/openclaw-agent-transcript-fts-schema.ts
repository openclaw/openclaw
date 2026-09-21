import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

function transcriptFtsRowsSchemaSql(schema: string): string {
  return extractSqliteTableSchema(schema, "session_transcript_fts_rows", {
    endMarker: "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(",
    includeEndMarker: false,
  });
}

/** Older migration preflights must compare the schema before exact FTS row ownership. */
export function withoutTranscriptFtsRowSchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_transcript_fts_rows (")) {
    return schema;
  }
  return schema
    .replace(transcriptFtsRowsSchemaSql(schema), "")
    .replace("  fts_row_count INTEGER,\n", "");
}

/** Leave existing FTS bytes intact; the projection owner heals each session lazily. */
export function migrateTranscriptFtsRowSchema(database: DatabaseSync): void {
  // sqlite-allow-raw -- Install canonical DDL in the versioned schema migration.
  database.exec(transcriptFtsRowsSchemaSql(OPENCLAW_AGENT_SCHEMA_SQL));
  if (!tableHasColumn(database, "session_transcript_index_state", "fts_row_count")) {
    // sqlite-allow-raw -- Add the migration-owned nullable completeness fact.
    database.exec("ALTER TABLE session_transcript_index_state ADD COLUMN fts_row_count INTEGER;");
  }
  // sqlite-allow-raw -- Invalidate legacy derived state once during schema migration.
  database.exec(
    "UPDATE session_transcript_index_state SET needs_rebuild = 1, fts_row_count = NULL;",
  );
}
