import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isDeletedAgentDatabasePath } from "../infra/agent-database-readers.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  getSqliteReadScopeRevision,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  classifyOpenClawAgentDatabaseReadError,
  recordOpenClawAgentDatabaseReadOpenFailure,
} from "./openclaw-agent-db-read-error.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import { assertAgentDatabaseTerminalOpenAllowed } from "./openclaw-agent-db-terminal.js";
import { hasOpenClawAgentCanonicalValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

export type OpenClawAgentReadOnlyDatabase = {
  agentId: string;
  db: DatabaseSync;
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
  assertCanonicalAgentPersistenceVersion(database.db, database.path, userVersion);
  const schemaMeta = readExistingAgentSchemaMeta(database.db);
  if (!schemaMeta) {
    return false;
  }
  assertExistingAgentSchemaOwner(schemaMeta, database.agentId, database.path);
  assertCanonicalSessionValidationSchema(database.db);
  return true;
}

/** Retained grants reuse their fresh read scope without re-admitting changed schema under a lock. */
export function captureOpenClawAgentReadOnlyAdmission(database: OpenClawAgentReadOnlyDatabase) {
  const changed = () =>
    new SqliteSchemaMismatchError(
      `OpenClaw agent database ${database.path} schema admission changed; retry the request.`,
    );
  const schema = getAdmittedSqliteSchemaFacts(database.db);
  if (!schema) {
    throw changed();
  }
  return () => {
    if (
      getSqliteReadScopeRevision(database.db)?.schema !== schema ||
      !hasAdmittedAgentReadOnlySchema(database)
    ) {
      throw changed();
    }
  };
}

/** Recheck committed admission facts before using an existing read-only connection. */
export function hasOpenClawAgentReadOnlySchema(database: OpenClawAgentReadOnlyDatabase): boolean {
  return runSqliteReadOperationSync(
    database.db,
    () => hasAdmittedAgentReadOnlySchema(database),
    "fresh",
  );
}

/** Admit ownership and consume its rows in the same freshly pinned snapshot. */
export function readOpenClawAgentDatabaseSnapshot<T>(
  database: OpenClawAgentReadOnlyDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
): OpenClawAgentDatabaseReadOnlyResult<T> {
  let result: OpenClawAgentDatabaseReadOnlyResult<T> = { found: false, reason: "schema-missing" };
  runSqliteDeferredTransactionSync(database.db, () => {
    if (hasAdmittedAgentReadOnlySchema(database)) {
      result = readOpenClawAgentDatabase(database, operation);
      // Return the callback value so the transaction owner rejects asynchronous kernels.
      return result.value;
    }
    return undefined;
  });
  return result;
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
  behavior: { allowExtension?: boolean } = {},
): OpenClawAgentDatabaseReadOnlyOpenResult {
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
  assertAgentDatabaseTerminalOpenAllowed(pathname);
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
    db = openSqliteReadOnlyDatabase(pathname, {
      timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      ...(behavior.allowExtension ? { allowExtension: true } : {}),
    });
  } catch (error) {
    recordOpenClawAgentDatabaseReadOpenFailure(error);
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    if (db.isOpen) {
      db.close();
    }
    closed = true;
  };
  try {
    enableNodeSqliteKyselyStatementCache(db);
    registerOpenClawAgentDatabaseIdentity(db);
    const privatePath = isArtifactPreservingStateRead("agent", pathname)
      ? db.location()
      : undefined;
    const database = { agentId, db, path: privatePath ?? pathname, close };
    const hasSchema = runSqliteReadOperationSync(db, () => {
      admitSqliteSchema(db);
      return hasAdmittedAgentReadOnlySchema(database);
    });
    if (!hasSchema) {
      close();
      return { found: false, reason: "schema-missing" };
    }
    // Worker admission loads file-bound proof before a read transaction prevents it.
    if (!isMainThread) {
      hasOpenClawAgentCanonicalValidation(database);
    }
    return { found: true, database };
  } catch (error) {
    close();
    recordOpenClawAgentDatabaseReadOpenFailure(error);
    throw error;
  }
}
