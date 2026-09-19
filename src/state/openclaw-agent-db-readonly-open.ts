import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { sqliteErrorCode } from "../infra/sqlite-error-diagnostics.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
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
  | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };

/** Recheck committed admission facts before using an existing read-only connection. */
export function hasOpenClawAgentReadOnlySchema(database: OpenClawAgentReadOnlyDatabase): boolean {
  const userVersion = assertSupportedAgentSchemaVersion(database.db, database.path);
  assertCanonicalAgentPersistenceVersion(database.db, database.path, userVersion);
  const schemaMeta = readExistingAgentSchemaMeta(database.db);
  if (!schemaMeta) {
    return false;
  }
  assertExistingAgentSchemaOwner(schemaMeta, database.agentId, database.path);
  return true;
}

/** Apply the same missing-table policy to fresh and borrowed read-only queries. */
export function readOpenClawAgentDatabaseReadOnly<T>(
  database: OpenClawAgentReadOnlyDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  behavior: { throwOnMissingTable?: boolean } = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  try {
    return { found: true, value: operation(database) };
  } catch (error) {
    if (
      error instanceof Error &&
      sqliteErrorCode(error) === "ERR_SQLITE_ERROR" &&
      /\bno such table:/iu.test(error.message) &&
      !behavior.throwOnMissingTable
    ) {
      return { found: false, reason: "table-missing" };
    }
    throw error;
  }
}

/** Fresh-only callers do not need the writable runtime's process-held connection cache. */
export function withFreshOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: { allowExtension?: boolean; throwOnMissingTable?: boolean } = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  const opened = openOpenClawAgentDatabaseReadOnly(options, behavior);
  if (!opened.found) {
    return opened;
  }
  try {
    return readOpenClawAgentDatabaseReadOnly(opened.database, operation, behavior);
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
  if (!fs.existsSync(pathname)) {
    return { found: false, reason: "database-missing" };
  }
  // Lock policy belongs to the open: node:sqlite has no busy handler until one
  // is set, so a later PRAGMA leaves every earlier statement unprotected.
  const db = openNodeSqliteDatabase(pathname, {
    readOnly: true,
    timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    ...(behavior.allowExtension ? { allowExtension: true } : {}),
  });
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    closed = true;
  };
  try {
    registerOpenClawAgentDatabaseIdentity(db);
    const database = { agentId, db, path: pathname, close };
    if (!hasOpenClawAgentReadOnlySchema(database)) {
      close();
      return { found: false, reason: "schema-missing" };
    }
    return { found: true, database };
  } catch (error) {
    close();
    throw error;
  }
}
