import type { DatabaseSync } from "node:sqlite";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { assertAgentSchemaVersion } from "./openclaw-agent-db-schema-helpers.js";
import {
  DURABLE_QUESTIONS_SCHEMA_VERSION,
  sessionQuestionsSchemaSql,
} from "./openclaw-agent-questions-schema.js";

/** Publish only inside the caller-owned migration transaction and maintenance scope. */
export function finishAgentSchemaMigration(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion: number,
  schemaSql: string,
  requiresMaintenance: boolean,
  assertMigration: () => void,
): void {
  if (
    targetVersion >= DURABLE_QUESTIONS_SCHEMA_VERSION &&
    readSqliteUserVersion(db) < DURABLE_QUESTIONS_SCHEMA_VERSION
  ) {
    // The specialized writer/snapshot upgrade path does not execute the whole
    // target schema. Install its additive question contract before publication.
    db.exec(sessionQuestionsSchemaSql(schemaSql));
  }
  repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
    verifyPhysicalIntegrity: false,
  });
  db.exec(`PRAGMA user_version = ${targetVersion};`);
  persistAgentSchemaMetadata(db, agentId, targetVersion);
  assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
  if (requiresMaintenance && db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error(`Agent schema migration failed foreign key validation for ${pathname}.`);
  }
  assertMigration();
}
