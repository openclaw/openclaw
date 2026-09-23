import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";
import { detectOpenClawStateDatabaseSchemaMigrationsFromDatabase } from "./openclaw-state-db-schema-repair.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases"> & {
  sqlite_master: { name: string; type: string };
};

/** Read durable registrations from an already opened live or captured database. */
export function readOpenClawAgentDatabaseRegistryRows(database: DatabaseSync, pathname: string) {
  const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database);
  const registryTable = executeSqliteQueryTakeFirstSync(
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
  const schemaMigrations = detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(
    database,
    pathname,
  );
  if (!artifactPreserving && schemaMigrations.length > 0) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
    );
  }
  return readOpenClawAgentDatabaseRegistryRows(database, pathname).map((row) => ({
    agentId: normalizeAgentId(row.agent_id),
    path: resolveOpenClawRegisteredAgentDatabasePath(pathname, row.path),
    schemaVersion: row.schema_version,
    lastSeenAt: row.last_seen_at,
    sizeBytes: row.size_bytes,
  }));
}
