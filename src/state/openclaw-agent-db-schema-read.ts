import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import type { ExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";

export { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";

export function readAgentDatabaseSchemaVersion(db: EngineConnection): number {
  if (isPostgresSqlConnection(db)) {
    const facts = getPostgresPhysicalFacts(db);
    if (!facts) {
      throw new Error("Agent database has no PostgreSQL schema admission");
    }
    return facts.version;
  }
  return getAdmittedSqliteSchemaFacts(db)?.userVersion ?? readSqliteUserVersion(db);
}

export function assertSupportedAgentSchemaVersion(
  db: EngineConnection,
  pathname: string,
  userVersion = readAgentDatabaseSchemaVersion(db),
): number {
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

export function hasAgentDatabaseApplicationSchema(db: EngineConnection): boolean {
  if (isPostgresSqlConnection(db)) {
    return Boolean(getPostgresPhysicalFacts(db)?.catalog.some((fact) => fact.kind === "table"));
  }
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    for (const names of [schema.tables, schema.views, schema.indexes, schema.triggers.keys()]) {
      for (const name of names) {
        if (!name.startsWith("sqlite_")) {
          return true;
        }
      }
    }
    return false;
  }
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1").get(),
  );
}

/** Persistence gates consume the catalog published by admission or schema maintenance. */
export function assertCanonicalAgentPersistenceVersion(
  db: EngineConnection,
  pathname: string,
  userVersion = readAgentDatabaseSchemaVersion(db),
): void {
  if (getAdmittedSqliteSchemaFacts(db)?.tables.has("openclaw_engine_anchor")) {
    throw new Error(
      "This agent store lives in PostgreSQL; set database.engine to postgres and configure database.postgres.connection.",
    );
  }
  const isNewUnownedDatabase = userVersion === 0 && !hasAgentDatabaseApplicationSchema(db);
  if (userVersion < AGENT_MEDIA_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new OpenClawAgentDatabaseMediaMigrationRequiredError(pathname, userVersion);
  }
  if (userVersion < OPENCLAW_AGENT_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new SqliteSchemaMismatchError(
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
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has schema role ${existing.role ?? "unknown"}; expected agent. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  if (!existing.agentId) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has no agent owner. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  if (normalizeAgentId(existing.agentId) !== agentId) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} belongs to agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
}

export function assertCurrentAgentSchemaMetadata(
  metadata: ExistingAgentSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  if (!metadata) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has no schema ownership metadata. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, pathname);
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before using it.`,
    );
  }
}
