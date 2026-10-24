import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isDeletedAgentDatabasePath } from "../infra/agent-database-readers.js";
import { assertEngineStoreExecutionAllowed } from "../infra/database-engine/admission-scope.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import { loadOpenClawAgentCanonicalValidationReceipt } from "./openclaw-agent-canonical-validation-receipt.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { hasPendingAgentStartupColumns } from "./openclaw-agent-db-additive-columns.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { agentEngineInput, openAgentEngineStore } from "./openclaw-agent-db-engine.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  classifyOpenClawAgentDatabaseReadError,
  recordOpenClawAgentDatabaseReadOpenFailure,
} from "./openclaw-agent-db-read-error.js";
import { registerOpenClawAgentDatabaseSyncResource } from "./openclaw-agent-db-resources.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import { revalidateAgentDatabaseTerminalOpen } from "./openclaw-agent-db-terminal.js";
import {
  adoptOpenClawAgentDatabaseSchema,
  hasOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

export type OpenClawAgentReadOnlyDatabase = {
  agentId: string;
  db: EngineConnection;
  path: string;
};

export type OpenClawAgentReadOnlyDatabaseHandle = OpenClawAgentReadOnlyDatabase & {
  close: () => void;
};

export type OpenClawAgentDatabaseReadOnlyOpenResult =
  | { found: true; database: OpenClawAgentReadOnlyDatabaseHandle }
  | { found: false; reason: "database-missing" | "schema-missing" };

export type OpenClawAgentDatabaseReadOnlyResult<T> =
  | { found: true; value: T }
  | { found: false; reason: "database-missing" | "schema-missing" };

export function readOpenClawAgentDatabase<T>(
  database: OpenClawAgentReadOnlyDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
): { found: true; value: T } {
  try {
    return { found: true, value: operation(database) };
  } catch (error) {
    throw sqlitePrimaryResultCode(error) === 1
      ? classifyOpenClawAgentDatabaseReadError(database.db, error)
      : error;
  }
}

function hasAdmittedAgentReadOnlySchema(database: OpenClawAgentReadOnlyDatabase): boolean {
  const userVersion = assertSupportedAgentSchemaVersion(database.db, database.path);
  const schemaMeta = readExistingAgentSchemaMeta(database.db);
  assertCanonicalAgentPersistenceVersion(database.db, database.path, userVersion);
  if (!schemaMeta) {
    return false;
  }
  assertExistingAgentSchemaOwner(schemaMeta, database.agentId, database.path);
  assertCanonicalSessionValidationSchema(database.db);
  return true;
}

/** Recheck admission and consume retained rows in the same fresh synchronous scope. */
export function hasOpenClawAgentReadOnlySchema(
  database: OpenClawAgentReadOnlyDatabase,
  onAdmitted?: () => void,
): boolean {
  return runSqliteReadOperationSync(database.db, () => {
    if (!hasAdmittedAgentReadOnlySchema(database)) {
      return false;
    }
    onAdmitted?.();
    return true;
  });
}

/** Admit ownership and consume its rows in the same freshly pinned snapshot. */
export function readOpenClawAgentDatabaseSnapshot<T>(
  database: OpenClawAgentReadOnlyDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
): OpenClawAgentDatabaseReadOnlyResult<T> {
  const value = runSqliteReadSnapshotSync(
    database.db,
    () => readOpenClawAgentDatabase(database, operation).value,
  );
  return { found: true, value };
}

/** Fresh-only callers do not need the writable runtime's process-held connection cache. */
export function withFreshOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: { allowExtension?: boolean; snapshot?: boolean } = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  const opened = openOpenClawAgentDatabaseReadOnly(options, behavior);
  if (!opened.found) {
    return opened;
  }
  try {
    return behavior.snapshot
      ? readOpenClawAgentDatabaseSnapshot(opened.database, operation)
      : readOpenClawAgentDatabase(opened.database, operation);
  } finally {
    opened.database.close();
  }
}

/** Open one existing agent database without creating, registering, migrating, or adopting it. */
export function openOpenClawAgentDatabaseReadOnly(
  options: OpenClawAgentDatabaseOptions,
  behavior: { allowExtension?: boolean; lifecycle?: "agent" } = {},
): OpenClawAgentDatabaseReadOnlyOpenResult {
  const engineInput = agentEngineInput();
  if (engineInput) {
    assertEngineStoreExecutionAllowed();
  }
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  if (isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env })) {
    return { found: false, reason: "database-missing" };
  }
  if (isDeletedAgentDatabasePath(pathname) || !fs.existsSync(pathname)) {
    return { found: false, reason: "database-missing" };
  }
  // Verified-corrupt generations stay quarantined for reads as well as writes:
  // the process terminal latch and the persisted generation-aware quarantine
  // row must both clear before any fresh read-only physical open proceeds.
  revalidateAgentDatabaseTerminalOpen(pathname);
  const persistedQuarantine = readOpenClawDatabaseQuarantineFailure("agent", pathname, {
    env: options.env,
  });
  if (persistedQuarantine) {
    recordOpenClawAgentDatabaseReadOpenFailure(persistedQuarantine);
    throw persistedQuarantine;
  }
  // Lock policy belongs to the open: node:sqlite has no busy handler until one
  // is set, so a later PRAGMA leaves every earlier statement unprotected.
  let db: DatabaseSync;
  try {
    db = engineInput
      ? openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname), {
          timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        })
      : openSqliteReadOnlyDatabase(pathname, {
          timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          ...(behavior.allowExtension ? { allowExtension: true } : {}),
        });
  } catch (error) {
    recordOpenClawAgentDatabaseReadOpenFailure(error);
    throw error;
  }
  let closed = false;
  let selected: EngineConnection = db;
  let unregister: (() => void) | undefined;
  const close = () => {
    if (closed) {
      return;
    }
    if (selected !== db && selected.isOpen) {
      selected.close();
    }
    if (db.isOpen) {
      db.close();
    }
    closed = true;
    unregister?.();
    unregister = undefined;
  };
  try {
    let database: OpenClawAgentReadOnlyDatabaseHandle;
    if (engineInput) {
      selected = openAgentEngineStore(db, agentId, pathname, true, (connection, error) => {
        selected = connection;
        throw error;
      });
      registerOpenClawAgentDatabaseIdentity(selected);
      database = { agentId, db: selected, path: pathname, close };
    } else {
      enableNodeSqliteKyselyStatementCache(db);
      registerOpenClawAgentDatabaseIdentity(db);
      const privatePath = isArtifactPreservingStateRead("agent", pathname)
        ? db.location()
        : undefined;
      database = { agentId, db, path: privatePath ?? pathname, close };
      // The physical owner already checked ownership and canonical definitions.
      const hasSchema =
        adoptOpenClawAgentDatabaseSchema(database) ||
        runSqliteReadOperationSync(db, () => {
          admitSqliteSchema(db);
          if (!hasAdmittedAgentReadOnlySchema(database)) {
            return false;
          }
          const schema = getAdmittedSqliteSchemaFacts(database.db);
          if (schema && hasPendingAgentStartupColumns(schema.tableSql)) {
            throw new SqliteSchemaMismatchError(
              `OpenClaw agent database ${database.path} requires writable startup admission before session reads; restart the Gateway or run openclaw doctor --fix.`,
            );
          }
          return true;
        });
      if (!hasSchema) {
        close();
        return { found: false, reason: "schema-missing" };
      }
      // Worker admission loads file-bound proof before a read transaction prevents it.
      if (!isMainThread) {
        loadOpenClawAgentCanonicalValidationReceipt(database);
        hasOpenClawAgentCanonicalValidation(database);
      }
    }
    if (behavior.lifecycle === "agent") {
      unregister = registerOpenClawAgentDatabaseSyncResource({
        agentId,
        path: pathname,
        revoke: close,
        close,
      });
    }
    return { found: true, database };
  } catch (error) {
    close();
    recordOpenClawAgentDatabaseReadOpenFailure(error);
    throw error;
  }
}
