import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";
import {
  assertCanonicalAgentDatabasesPrimaryKey,
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
} from "./openclaw-state-db-schema-repair.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases"> & {
  sqlite_master: { name: string; type: string };
};

// Admission owns schema revisions; current writers cannot reintroduce legacy migration rows.
const readableSchemas = new WeakSet<SqliteSchemaFacts>();

/** Read durable registrations from an already opened live or captured database. */
export function readOpenClawAgentDatabaseRegistryRows(database: DatabaseSync, pathname: string) {
  const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database);
  const schema = getAdmittedSqliteSchemaFacts(database);
  const registryTable = schema
    ? schema.tables.has("agent_databases")
      ? { type: "table" }
      : schema.views.has("agent_databases") ||
          schema.indexes.has("agent_databases") ||
          schema.triggers.has("agent_databases")
        ? { type: "invalid" }
        : undefined
    : executeSqliteQueryTakeFirstSync(
        database,
        db.selectFrom("sqlite_master").select("type").where("name", "=", "agent_databases"),
      );
  if (!registryTable) {
    return [];
  }
  if (registryTable.type !== "table") {
    throw new Error(`OpenClaw state database ${pathname} has an invalid agent registry.`);
  }
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_databases").selectAll().orderBy("agent_id", "asc").orderBy("path", "asc"),
  ).rows;
}

export function readAgentDatabasePreflightTargets(database: DatabaseSync, registryPath: string) {
  return readOpenClawAgentDatabaseRegistryRows(database, registryPath).flatMap((row) =>
    typeof row.agent_id === "string" && typeof row.path === "string"
      ? [
          {
            agentId: row.agent_id,
            path: resolveOpenClawRegisteredAgentDatabasePath(registryPath, row.path),
          },
        ]
      : [],
  );
}

export function readRegisteredAgentDatabaseRows(
  database: DatabaseSync,
  pathname: string,
  artifactPreserving: boolean,
): OpenClawRegisteredAgentDatabase[] {
  if (artifactPreserving) {
    assertCanonicalAgentDatabasesPrimaryKey(database, pathname);
  } else {
    const schema = getAdmittedSqliteSchemaFacts(database);
    if (!schema || !readableSchemas.has(schema)) {
      // Transcript and retention projections do not change the registry's read contract.
      if (
        detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).some(
          ({ kind }) => kind !== "predicate-columns-v21",
        )
      ) {
        throw new Error(
          `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
        );
      }
      if (schema) {
        readableSchemas.add(schema);
      }
    }
  }
  return readOpenClawAgentDatabaseRegistryRows(database, pathname).map((row) => ({
    agentId: normalizeAgentId(row.agent_id),
    path: resolveOpenClawRegisteredAgentDatabasePath(pathname, row.path),
    schemaVersion: row.schema_version,
    lastSeenAt: row.last_seen_at,
    sizeBytes: row.size_bytes,
  }));
}
