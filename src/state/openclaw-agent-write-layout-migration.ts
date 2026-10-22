import type { DatabaseSync } from "node:sqlite";
import { migrateSqliteTableWithoutRowid } from "./sqlite-table-layout-migration.js";

/** Version 27 differs only in these indexes; WITHOUT ROWID has no PostgreSQL equivalent. */
export function withLegacyAgentPostgresWriteLayout(schema: string): string {
  return `${schema}
    DROP INDEX "idx_agent_session_windows_conversation";
    CREATE INDEX "idx_agent_session_windows_conversation"
      ON "session_windows" (("primary_conversation_id") ASC NULLS FIRST,
        ("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST)
      WHERE "primary_conversation_id" IS NOT NULL;
    CREATE INDEX "idx_agent_transcript_event_parent"
      ON "transcript_event_identities" (("session_id") ASC NULLS FIRST,
        ("parent_id") ASC NULLS FIRST)
      WHERE "parent_id" IS NOT NULL;
  `;
}

export const AGENT_WRITE_LAYOUT_POSTGRES_MIGRATION_SQL = `
  DROP INDEX "idx_agent_transcript_event_parent";
  DROP INDEX "idx_agent_session_windows_conversation";
  CREATE INDEX "idx_agent_session_windows_conversation"
    ON "session_windows" (("primary_conversation_id") ASC NULLS FIRST)
    WHERE "primary_conversation_id" IS NOT NULL;
`;

/** The schema owner holds exclusive migration custody and the surrounding transaction. */
export function migrateAgentWriteLayoutInTransaction(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_agent_transcript_event_parent;
    DROP INDEX IF EXISTS idx_agent_session_windows_conversation;
    CREATE INDEX idx_agent_session_windows_conversation
      ON session_windows(primary_conversation_id)
      WHERE primary_conversation_id IS NOT NULL;
  `);
  migrateSqliteTableWithoutRowid(database, "memory_entry_origins");
}
