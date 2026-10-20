import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { getOrLoadSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import {
  invalidateSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import {
  assertAgentCreationClaimAccess,
  assertAgentCreationClaimAliases,
} from "./agent-creation-claim.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionCleanupAliases,
  assertAgentDeletionDatabaseCleanupAccess,
} from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseReadAccess,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import { agentEngineInput, openAgentEngineStore } from "./openclaw-agent-db-engine.js";
import { agentSchemaMetadataKey } from "./openclaw-agent-db-metadata.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
  options?: { revalidateSchema: true },
): OpenClawAgentDatabaseOwnerInspection {
  if (isMainThread && agentEngineInput()) {
    const metadata = getOrLoadSqliteDatabaseAdmissionForPath(
      pathname,
      agentSchemaMetadataKey,
      () => undefined,
    );
    if (!options?.revalidateSchema && metadata?.role === "agent" && metadata.agentId) {
      return { status: "owned", agentId: normalizeAgentId(metadata.agentId) };
    }
    throw new Error(
      "PostgreSQL agent ownership requires worker preparation before synchronous inspection; use the asynchronous agent database preparation owner.",
    );
  }
  let db: DatabaseSync | undefined;
  let engine: EngineConnection | undefined;
  try {
    // Failed-open entries retain disposal custody but cannot assert database ownership.
    const owner = getOpenClawAgentDatabaseReadAccess();
    const resolvedPath = path.resolve(pathname);
    const opened = owner?.databases.get(resolvedPath);
    if (
      owner &&
      !options?.revalidateSchema &&
      opened?.db.isOpen &&
      !owner.failures.has(resolvedPath)
    ) {
      runSqliteReadOperationSync(opened.db, () =>
        assertSupportedAgentSchemaVersion(opened.db, pathname),
      );
      owner.refreshIdle(opened);
      return { status: "owned", agentId: opened.agentId };
    }
    db = agentEngineInput()
      ? openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname), {
          timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        })
      : openSqliteReadOnlyDatabase(pathname, { readOnly: true });
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    if (agentEngineInput()) {
      engine = openAgentEngineStore(db, undefined, pathname, true);
    } else if (options?.revalidateSchema) {
      invalidateSqliteSchemaFacts(db);
    }
    assertSupportedAgentSchemaVersion(engine ?? db, pathname);
    const existing = readExistingAgentSchemaMeta(engine ?? db);
    if (!existing) {
      return { status: "unowned" };
    }
    if (existing.role !== "agent" || !existing.agentId) {
      return { status: "unreadable" };
    }
    return { status: "owned", agentId: normalizeAgentId(existing.agentId) };
  } catch {
    return { status: "unreadable" };
  } finally {
    try {
      engine?.close();
    } finally {
      db?.close();
    }
  }
}

/** A reader can precede writer startup, so absence must never be cached. */
export function getOpenClawAgentDatabaseReadAccess(): OpenClawAgentDatabaseReadAccess | undefined {
  // SAFETY: The agent lifecycle owns these maps and the callbacks that retain its physical handles.
  return readGlobalSingleton(Symbol.for("openclaw.agentDatabaseLifecycle")) as
    | OpenClawAgentDatabaseReadAccess
    | undefined;
}

/** Return the matching live cache entry without materializing a database. */
export function getOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const owner = getOpenClawAgentDatabaseReadAccess();
  const database = owner?.databases.get(pathname);
  if (!owner || !database?.db.isOpen) {
    assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
    assertAgentCreationClaimAliases(options);
    return undefined;
  }
  if (owner.failures.has(pathname)) {
    throw owner.failures.get(pathname);
  }
  if (database.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${database.agentId}; requested agent ${agentId}.`,
    );
  }
  assertAgentDeletionDatabaseCleanupAccess(database, options);
  assertAgentCreationClaimAccess(database, options);
  observeOpenClawDatabaseMaintenanceResource(database.db);
  owner.refreshIdle(database);
  return database;
}
