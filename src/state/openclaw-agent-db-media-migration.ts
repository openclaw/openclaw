import type { DatabaseSync } from "node:sqlite";
import type { SqliteIntegrityOperation } from "../infra/sqlite-integrity.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import * as maintenanceAuthority from "./openclaw-agent-db-lease.js";
import {
  assertExistingAgentSchemaOwner,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  agentDatabaseIntegrityBeforeMutationSteps,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { assertSupportedAgentMigrationSchemas } from "./openclaw-agent-db-session-migrations.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** Upgrade older owned databases to the structural schema required by the media cutover. */
export function* migrateOpenClawAgentDatabaseToMediaPrerequisiteSchemaSteps(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions,
): SqliteIntegrityOperation<void> {
  const targetVersion = AGENT_MEDIA_SCHEMA_VERSION - 1;
  if (readSqliteUserVersion(db) > targetVersion) {
    return;
  }
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  assertSupportedAgentMigrationSchemas(db, pathname, readSqliteUserVersion(db));
  if (db.location()) {
    maintenanceAuthority.invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
      pathname,
      options.env,
    );
  }
  yield* agentDatabaseIntegrityBeforeMutationSteps(db, agentId, pathname);
  configureSqlitePreSchemaPragmas(db, {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  ensureOpenClawAgentSchema(db, agentId, pathname, targetVersion);
}
