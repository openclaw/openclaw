import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import {
  readExistingAgentSchemaMeta,
  type ExistingAgentSchemaMeta,
} from "./openclaw-agent-db-metadata.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";

export { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";

export function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): number {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      pathname,
      userVersion,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  return userVersion;
}

/** Readers may pass their immediate check; writers reread the version after integrity work. */
export function assertCanonicalAgentPersistenceVersion(
  db: DatabaseSync,
  pathname: string,
  userVersion = readSqliteUserVersion(db),
): void {
  const hasApplicationSchema =
    userVersion === 0 &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1").get();
  const isNewUnownedDatabase =
    userVersion === 0 && readExistingAgentSchemaMeta(db) === null && !hasApplicationSchema;
  if (userVersion < AGENT_MEDIA_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new OpenClawAgentDatabaseMediaMigrationRequiredError(pathname, userVersion);
  }
  if (userVersion < OPENCLAW_AGENT_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new Error(
      `OpenClaw agent database ${pathname} uses schema version ${userVersion}; stop active agents and run openclaw doctor --fix to migrate session identities before using it.`,
    );
  }
}

export function assertExistingAgentSchemaOwner(
  existing: ExistingAgentSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  if (!existing) {
    return;
  }
  // Agent DB files are not interchangeable; opening another role/id would corrupt ownership.
  if (existing.role !== "agent") {
    throw new Error(
      `OpenClaw agent database ${pathname} has schema role ${existing.role ?? "unknown"}; expected agent.`,
    );
  }
  if (!existing.agentId) {
    throw new Error(`OpenClaw agent database ${pathname} has no agent owner.`);
  }
  if (normalizeAgentId(existing.agentId) !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} belongs to agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
}
