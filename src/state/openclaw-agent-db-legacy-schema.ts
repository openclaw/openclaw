import type { DatabaseSync } from "node:sqlite";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { readSqliteTableColumns } from "./openclaw-agent-db-session-migrations.js";
import {
  addSessionProvenanceColumns,
  backfillTranscriptMutationWatermarks,
} from "./openclaw-agent-db-session-provenance.js";

export function migrateOpenClawAgentSchema(db: DatabaseSync): void {
  if (readSqliteUserVersion(db) >= OPENCLAW_AGENT_SCHEMA_VERSION) {
    return;
  }
  const columns = readSqliteTableColumns(db, "sessions");
  if (!columns) {
    return;
  }
  if (!columns.has("transcript_updated_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_updated_at INTEGER DEFAULT NULL;");
  }
  if (!columns.has("transcript_observed_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_observed_at INTEGER DEFAULT NULL;");
  }
  addSessionProvenanceColumns(db, columns);
  backfillTranscriptMutationWatermarks(db);
}
