import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

// Deployed by 00caa84ce72c0b4edd584cfa225bd262cd10ba49; NULL counts mean unknown ownership.
export const DEPLOYED_FTS_ROWS_SCHEMA = `CREATE TABLE IF NOT EXISTS session_transcript_fts_rows (
  session_id TEXT NOT NULL,
  fts_rowid INTEGER NOT NULL PRIMARY KEY
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_transcript_fts_rows_session
  ON session_transcript_fts_rows(session_id);
`;

/** Describe the deployed schema-22 predecessor, independently of the new row-map layout. */
export function withDeployedTranscriptFtsRowSchema(legacyStorageSchema: string): string {
  const indexState = extractSqliteTableSchema(
    legacyStorageSchema,
    "session_transcript_index_state",
  );
  return legacyStorageSchema
    .replace(
      indexState,
      indexState.replace(
        "  updated_at INTEGER NOT NULL,",
        "  fts_row_count INTEGER,\n  updated_at INTEGER NOT NULL,",
      ),
    )
    .replace(
      "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(",
      `${DEPLOYED_FTS_ROWS_SCHEMA}\nCREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(`,
    );
}
