import { statSync } from "node:fs";
import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { invalidateRegisteredAgentDatabasesMemo } from "./openclaw-agent-db-registry-listing.js";
import {
  invalidateOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidationsForAgent,
} from "./openclaw-agent-db-validation-cache.js";
import {
  isPersistentOpenClawAgentDatabasePath,
  isSameOpenClawAgentDatabasePath,
} from "./openclaw-agent-db.paths.js";
import { requireOpenClawStateDatabaseIdentity } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

export {
  inspectOpenClawRegisteredAgentDatabases,
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry-listing.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

function resolveRegisteredAgentDatabaseStoredPath(
  database: OpenClawStateDatabase,
  params: { agentId: string; path: string },
): string {
  const storedPath = resolveOpenClawAgentDatabaseStoredPath(database.path, params.path);
  if (params.path !== resolveIdentityPathViaExistingAncestorSync(params.path)) {
    return storedPath;
  }
  const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
  const { rows } = executeSqliteQuerySync(
    database.db,
    db.selectFrom("agent_databases").select("path").where("agent_id", "=", params.agentId),
  );
  // A canonical native open must update the existing configured locator, including external aliases.
  return rows.some((row) => row.path === storedPath)
    ? storedPath
    : (rows.find((row) =>
        isSameOpenClawAgentDatabasePath(
          resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
          params.path,
        ),
      )?.path ?? storedPath);
}

export function registerOpenClawAgentDatabase(
  params: {
    agentId: string;
    path: string;
    env?: NodeJS.ProcessEnv;
    schemaVersion?: number;
  },
  onCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
): void {
  if (!isPersistentOpenClawAgentDatabasePath(params.path, params.env)) {
    return;
  }
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId: params.agentId, path: params.path },
    { env: params.env },
  );
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      assertAgentDeletionPathFence(database, deletionFence);
      const storedPath = resolveRegisteredAgentDatabaseStoredPath(database, params);
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: storedPath,
            schema_version: params.schemaVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: params.schemaVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
      invalidateRegisteredAgentDatabasesMemo({ env: params.env });
      if (onCommitted) {
        const receipt = Object.freeze({
          agentId: params.agentId,
          agentPath: params.path,
          stateDatabasePath: database.path,
          stateDatabaseIdentity: requireOpenClawStateDatabaseIdentity(database).key,
        });
        // Record the native fact before fallible observers; the recorder never performs work.
        if (
          !stageSqliteTransactionState(database.db, {
            stage() {},
            rollback() {},
            commit: () => onCommitted(receipt),
          })
        ) {
          throw new Error(
            "Agent registration requires its canonical transaction publication scope",
          );
        }
      }
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    },
    { env: params.env },
  );
  invalidateOpenClawAgentDatabaseValidation(params.path);
}

export function unregisterOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const storedPath = resolveRegisteredAgentDatabaseStoredPath(database, params);
      const matchingPaths = [...new Set([storedPath, params.path, path.resolve(params.path)])];
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_databases")
          .where("agent_id", "=", params.agentId)
          .where("path", "in", matchingPaths),
      );
      invalidateRegisteredAgentDatabasesMemo({ env: params.env });
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    },
    { env: params.env, initializationAgentPaths: [params.path] },
  );
  invalidateOpenClawAgentDatabaseValidation(params.path);
}

/** Remove every durable database registration owned by a deleted agent. */
export function unregisterOpenClawAgentDatabases(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  database?: OpenClawStateDatabase;
}): void {
  const options = {
    env: params.env,
    ...(params.database ? { database: params.database, path: params.database.path } : {}),
  };
  const removedPaths = runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
    const removed = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("agent_databases").where("agent_id", "=", params.agentId).returning("path"),
    );
    invalidateRegisteredAgentDatabasesMemo(options);
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    return removed.rows.map((row) =>
      resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
    );
  }, options);
  invalidateOpenClawAgentDatabaseValidationsForAgent(params.agentId, removedPaths);
}
