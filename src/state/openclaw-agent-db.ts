// OpenClaw agent database stores agent-scoped persisted runtime state.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { registerSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionCleanupAliases,
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
  registerAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import { readAgentDeletionJournal } from "./agent-deletion-journal.js";
import { createOpenClawAgentDatabaseAdmissionOwner } from "./openclaw-agent-db-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import {
  registerOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  hasAgentDatabaseMaintenanceAuthority,
  assertOpenClawAgentDatabaseLease,
  claimOpenClawAgentDatabaseLease,
  recordOpenClawAgentDatabaseIntegrityVerified,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentIntegrityVerificationReceiver,
  type prepareOpenClawAgentDatabaseWorkerLease,
} from "./openclaw-agent-db-lease.js";
import {
  agentDatabaseLifecycle as cache,
  startAgentDatabaseOpenTiming,
  closeCachedOpenClawAgentDatabase,
  closeMaintenanceAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  refreshAgentDatabaseIdleTimer,
  retainAgentDatabase,
  retainFailedAgentDatabaseClose,
  revokePendingAgentDatabaseOpen,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-scope.js";
import {
  isSameOpenClawAgentDatabasePath,
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "./openclaw-agent-db-resources.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  agentDatabaseIntegrityBeforeMutationSteps,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { requestOpenClawAgentDatabaseQuickCheck } from "./openclaw-database-verify.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
  type OpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

export {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
export {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "./openclaw-agent-db-maintenance.js";
export { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
export {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry.js";
export { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
export {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export async function confirmOpenClawAgentDatabaseIntegrity(
  pathname: string,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = path.resolve(pathname);
  await closeOpenClawAgentDatabaseByPathAsync(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  const recorded = cache.terminal.record(pathname, error, generation);
  if (recorded) {
    // Quarantine revokes this process's trust because doctor may replace the file.
    invalidateOpenClawAgentDatabaseValidation(pathname);
  }
  return recorded;
}

/**
 * Clear a terminal open failure after doctor rewrites the database file.
 * Returns false when the persisted quarantine row survived; callers must
 * surface that, or the next open re-quarantines the repaired file.
 */
export function clearOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  const cleared = clearOpenClawDatabaseQuarantine(resolvedPath, { env: options.env });
  cache.terminal.clear(resolvedPath);
  return cleared;
}

/** Open or return a cached per-agent database after schema and owner validation. */
export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
  preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
  onRegistrationCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
): OpenClawAgentDatabase {
  const run = () =>
    runSqliteIntegrityOperationSync(
      openOpenClawAgentDatabaseSteps(options, undefined, preparedLease, onRegistrationCommitted),
    );
  const scope = getOpenClawDatabaseMaintenanceScope();
  return scope ? scope.run(run) : run();
}

export type { OpenClawAgentDatabaseWriteAdmission } from "./openclaw-agent-db-admission.js";
export const { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseAdmission } =
  createOpenClawAgentDatabaseAdmissionOwner(openOpenClawAgentDatabaseSteps);

function* openOpenClawAgentDatabaseSteps(
  options: OpenClawAgentDatabaseOptions,
  pending?: PendingAgentDatabaseOpen,
  preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
  onRegistrationCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
): SqliteIntegrityOperation<OpenClawAgentDatabase> {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  getAgentDeletionDatabaseCleanup(databaseOptions)?.assertCurrent();
  const incognito = isIncognitoOpenClawAgentSqlitePath(pathname, databaseOptions);
  // A live successful cache entry is authoritative; failed entries remain only for disposal.
  const opened = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  if (opened) {
    if (preparedLease) {
      throw new Error("A prepared Worker lease cannot adopt an existing agent database handle");
    }
    return opened;
  }
  if (!pending) {
    revokePendingAgentDatabaseOpen(pathname);
  }
  const cached = cache.databases.get(pathname);
  const allowExtension = !process.permission && supportsNodeSqliteExtensionLoading();
  if (incognito) {
    // The sentinel has no reachable durable owner, so doctor cannot safely migrate a collision.
    // Refuse operator-created state instead of silently shadowing it with volatile writes.
    assertIncognitoAgentDatabasePathAvailable(pathname);
    if (cached) {
      closeCachedOpenClawAgentDatabase(cached);
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
    }
    // After the collision probe, this sentinel is only a cache key: SQLite opens :memory:,
    // and no directory, lease, registry row, WAL sidecar, or file write may be created.
    const db = openNodeSqliteDatabase(":memory:", { allowExtension });
    db.enableLoadExtension(false);
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    });
    const walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: `openclaw-agent-incognito:${agentId}`,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureOpenClawAgentSchema(db, agentId, pathname);
    registerOpenClawAgentDatabaseIdentity(db);
    const database = { agentId, db, path: pathname, walMaintenance };
    cache.incognito.add(database);
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    cache.databases.set(pathname, database);
    cache.generation += 1;
    getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
      closeMaintenanceAgentDatabase(database),
    );
    return database;
  }
  quarantineOrphanedSqliteSidecars(pathname);
  // Latched paths are quarantined; every fresh open fails fast here until
  // doctor repairs the file and clears the latch plus the persisted row.
  const terminalFailure = cache.terminal.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  const persistedFailure = readOpenClawDatabaseQuarantineFailure("agent", pathname, {
    env: databaseOptions.env,
  });
  if (persistedFailure) {
    recordOpenClawAgentDatabaseOpenFailure(pathname, persistedFailure);
    throw persistedFailure;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    closeCachedOpenClawAgentDatabase(cached);
    cache.databases.delete(pathname);
    cache.failures.delete(pathname);
  }
  // Lease release must retain its original state owner after ambient env changes.
  const leaseEnvironment = {
    OPENCLAW_STATE_DIR: resolveStateDir(options.env ?? process.env),
    ...(isGatewayExternallySupervised(options.env ?? process.env)
      ? { OPENCLAW_SUPERVISOR_MODE: "external" }
      : {}),
  };
  if (
    preparedLease &&
    (preparedLease.receipt.agentId !== agentId || preparedLease.receipt.path !== pathname)
  ) {
    throw new Error("Prepared agent database lease belongs to another store");
  }
  let verification: OpenClawAgentIntegrityVerification | undefined;
  let hasLiveLease = false;
  const captureVerification: OpenClawAgentIntegrityVerificationReceiver = (record, liveLease) => {
    verification = record;
    hasLiveLease = liveLease;
  };
  const leaseId = preparedLease
    ? preparedLease.claim(captureVerification)
    : claimOpenClawAgentDatabaseLease(
        { agentId, path: pathname, env: leaseEnvironment },
        undefined,
        captureVerification,
      );
  if (pending) {
    pending.assertHeld = () =>
      assertOpenClawAgentDatabaseLease(leaseId, {
        agentId,
        path: pathname,
        env: leaseEnvironment,
      });
  }
  const diagnostics: SqliteIntegrityDiagnostics = {};
  const finishPhase = startAgentDatabaseOpenTiming(
    agentId,
    pathname,
    pending ? "async" : "sync",
    diagnostics,
  );
  let openedDb: DatabaseSync | undefined;
  let openedDatabase: OpenClawAgentDatabase | undefined;
  let openedWalMaintenance: SqliteWalMaintenance | undefined;
  try {
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    closeIdleOpenClawAgentDatabaseReadOnly(pathname);
    // Ordinary agent state also works with SQLite builds that omit extensions.
    // Trusted borrowers may enable them only when both the runtime and permissions allow it.
    const db = openNodeSqliteDatabase(pathname, { allowExtension });
    db.enableLoadExtension(false);
    enableNodeSqliteKyselyStatementCache(db);
    openedDb = db;
    if (preparedLease) {
      // Worker TEMP policy precedes schema/session caches and any exposed connection.
      db.exec("PRAGMA temp_store = FILE");
    }
    registerOpenClawAgentDatabaseIdentity(db);
    finishPhase("open");
    // Eviction churn must avoid migration/convergence and registry busy waits.
    // Version and owner can change while evicted, so their read-only gates run on every open.
    const validationDatabase = { db, path: pathname, agentId };
    const validation = pending?.validation ?? preparedLease?.validation;
    if (validation) {
      adoptOpenClawAgentDatabaseValidation(validationDatabase, validation);
    }
    let isValidatedReopen = Boolean(getOpenClawAgentDatabaseValidation(validationDatabase));
    const walMaintenance = yield* (function* (): SqliteIntegrityOperation<SqliteWalMaintenance> {
      let maintenance: OpenClawAgentDatabase["walMaintenance"] | undefined;
      try {
        db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        assertSupportedAgentSchemaVersion(db, pathname);
        const existingSchema = readExistingAgentSchemaMeta(db);
        assertExistingAgentSchemaOwner(existingSchema, agentId, pathname);
        // Live owners may lend runtime proof; cold opens require clean-close proof.
        // Both remain subject to durable invalidation and schema convergence.
        const requiresCurrentVersionConvergence = yield* agentDatabaseIntegrityBeforeMutationSteps(
          db,
          agentId,
          pathname,
          diagnostics,
          verification,
          isValidatedReopen && hasLiveLease,
        );
        if (isValidatedReopen && (!existingSchema || requiresCurrentVersionConvergence)) {
          // New files and same-version divergence cannot inherit an earlier validation.
          // The existing full path initializes or converges them before exposure.
          invalidateOpenClawAgentDatabaseValidation(pathname);
          isValidatedReopen = false;
        }
        assertCanonicalAgentPersistenceVersion(db, pathname);
        finishPhase("validation");
        configureSqlitePreSchemaPragmas(db, {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        });
        maintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: `openclaw-agent:${agentId}`,
          databasePath: pathname,
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        openedWalMaintenance = maintenance;
        finishPhase("configuration");
        if (!isValidatedReopen) {
          ensureOpenClawAgentSchema(db, agentId, pathname);
        }
        finishPhase("schema");
        return maintenance;
      } catch (err) {
        maintenance?.close();
        if (db.isOpen) {
          db.close();
        }
        const current = cache.databases.get(pathname);
        if (!current || current.db === db) {
          invalidateOpenClawAgentDatabaseValidation(pathname);
        }
        if (
          err instanceof Error &&
          (isSqliteSchemaVersionError(err) || isTerminalSqliteIntegrityError(err))
        ) {
          recordOpenClawAgentDatabaseOpenFailure(pathname, err);
        }
        throw err;
      }
    })();
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    const database = { agentId, db, path: pathname, walMaintenance };
    openedDatabase = database;
    if (hasAgentDatabaseMaintenanceAuthority()) {
      throw new Error(
        "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
      );
    }
    const cleanup = registerAgentDeletionDatabaseCleanup(database, databaseOptions);
    if (cleanup) {
      const release = retainAgentDatabase(db);
      cleanup.registerClose(() => {
        release();
        // The scope owns this connection, not a later cache entry at the same pathname.
        if (cache.databases.get(database.path) === database) {
          closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
        } else if (database.db.isOpen) {
          throw new Error("Agent deletion cleanup lost its database close owner.");
        }
      });
    }
    if (!isValidatedReopen) {
      registerOpenClawAgentDatabase(
        { agentId, path: pathname, env: options.env },
        onRegistrationCommitted,
      );
      setOpenClawAgentDatabaseValidation(database);
    }
    cache.terminal.clear(pathname);
    // Safety net for processes that end without an orderly close: agent DBs have
    // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    finishPhase("registration");
    cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
    cache.databases.set(pathname, database);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (diagnostics.integrityGateOutcome === "cached") {
      if (preparedLease) {
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: {
            kind: "agent-integrity-cached",
            lease: preparedLease.receipt,
          },
        });
      } else {
        requestOpenClawAgentDatabaseQuickCheck({ path: pathname, env: leaseEnvironment });
      }
    } else if (typeof identity === "string") {
      recordOpenClawAgentDatabaseIntegrityVerified(
        leaseId,
        { agentId, path: pathname, env: leaseEnvironment },
        identity,
      );
    }
    refreshAgentDatabaseIdleTimer(database);
    if (isMainThread) {
      const writeOptions = { agentId, path: pathname, env: leaseEnvironment };
      registerSqliteWalWriteAdmission(db, (operation) =>
        runOpenClawAgentWriteAdmission(writeOptions, () => {
          if (findOpenClawAgentDatabaseIfOpen(writeOptions) === database) {
            operation();
          }
        }),
      );
    }
    getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
      closeMaintenanceAgentDatabase(database),
    );
    return database;
  } catch (error) {
    let closeError: unknown;
    if (openedDatabase) {
      try {
        closeCachedOpenClawAgentDatabase(openedDatabase);
      } catch (caught) {
        closeError = caught;
      }
    }
    if (openedDb?.isOpen) {
      if (
        pending &&
        cache.databases.has(pathname) &&
        cache.databases.get(pathname)?.db !== openedDb
      ) {
        // A synchronous opener may supersede pending work. Retain failed cleanup
        // with its original native owner; never overwrite the replacement cache/lease.
        const retainedDb = openedDb;
        retainFailedAgentDatabaseClose(agentId, pathname, () => {
          openedWalMaintenance?.close();
          if (retainedDb.isOpen) {
            retainedDb.close();
          }
          releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment });
        });
        throw error;
      }
      invalidateOpenClawAgentDatabaseValidation(pathname);
      const retainedDatabase =
        openedDatabase ??
        ({
          agentId,
          db: openedDb,
          path: pathname,
          walMaintenance: openedWalMaintenance ?? {
            checkpoint: () => false,
            reclaimFreePages: createSqliteWalReclamationResult,
            close: () => false,
          },
        } satisfies OpenClawAgentDatabase);
      // Failed opens remain disposal-owned but cannot become successful cache hits.
      cache.databases.set(pathname, retainedDatabase);
      refreshAgentDatabaseIdleTimer(retainedDatabase);
      cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
      cache.failures.set(pathname, closeError ?? error);
      getOpenClawDatabaseMaintenanceScope()?.own(retainedDatabase.db, "agent-handles", () =>
        closeMaintenanceAgentDatabase(retainedDatabase),
      );
      cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    } else {
      try {
        releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment });
      } catch (releaseError) {
        retainFailedAgentDatabaseClose(agentId, pathname, () =>
          releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment }),
        );
        throw releaseError;
      }
    }
    throw closeError ?? error;
  }
}

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: () => void,
): boolean {
  return deferSqlitePostCommitPublication(database.db, publish);
}

export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openOpenClawAgentDatabase(options);
  const enteredNestedTransaction = database.db.isTransaction;
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteImmediateTransactionSync(
      database.db,
      () => {
        assertAgentDeletionDatabaseCleanupAccess(database, options);
        const operationResult = operation(database);
        if (!enteredNestedTransaction && !cache.incognito.has(database)) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          ensureOpenClawAgentDatabasePermissions(database.path, options);
        }
        return operationResult;
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
        withCommit: getAgentDeletionDatabaseCleanup(options)?.withCommit,
      },
    ),
  );
}

/** Retain the exact verified connection across awaits; explicit disposal still revokes it. */
export function borrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions): {
  db: DatabaseSync;
  release: () => void;
} {
  const { db } = openOpenClawAgentDatabase(options);
  return { db, release: retainAgentDatabase(db) };
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  return cache.databases.get(path.resolve(pathname))?.db.isOpen === true;
}

/** Return the matching live cache entry without materializing a database. */
export function getOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const database = findOpenClawAgentDatabaseIfOpen(options);
  if (database) {
    refreshAgentDatabaseIdleTimer(database);
  }
  return database;
}

function findOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  // Incognito skips durable database leases, but still follows the agent deletion fence.
  if (
    isIncognitoOpenClawAgentSqlitePath(pathname, options) &&
    readAgentDeletionJournal(agentId, { env: options.env })
  ) {
    throw new Error(`OpenClaw agent database is unavailable while agent ${agentId} is deleted.`);
  }
  const database = cache.databases.get(pathname);
  if (!database?.db.isOpen) {
    assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
    return undefined;
  }
  if (cache.failures.has(pathname)) {
    throw cache.failures.get(pathname);
  }
  if (database.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${database.agentId}; requested agent ${agentId}.`,
    );
  }
  assertAgentDeletionDatabaseCleanupAccess(database, options);
  observeOpenClawDatabaseMaintenanceResource(database.db);
  return database;
}

/** Pin only admitted native readers already present in captured discovery families. */
export function retainOpenClawAgentDatabaseReadCandidates(
  candidates: readonly Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope">[],
  env: NodeJS.ProcessEnv,
): { databases: readonly OpenClawAgentDatabase[]; release: () => void } {
  const retained: Array<{ database: OpenClawAgentDatabase; release: () => void }> = [];
  const release = () => {
    for (const reader of retained.toReversed()) {
      reader.release();
    }
  };
  try {
    for (const database of cache.databases.values()) {
      if (
        !database.db.isOpen ||
        database.db.isTransaction ||
        cache.incognito.has(database) ||
        !candidates.some((candidate) =>
          matchesAgentDatabaseReadCandidatePath(candidate, database.path),
        )
      ) {
        continue;
      }
      let admitted: OpenClawAgentDatabase | undefined;
      try {
        admitted = getOpenClawAgentDatabaseIfOpen({
          agentId: database.agentId,
          path: database.path,
          env,
        });
      } catch {
        // A refused cached writer cannot supply a read continuation. Fresh reads
        // retain the existing independent read-only schema and ownership checks.
        continue;
      }
      if (admitted === database) {
        retained.push({ database, release: retainAgentDatabase(database.db) });
      }
    }
    return { databases: retained.map(({ database }) => database), release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Close and unregister one unambiguous transient agent database by filesystem identity. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  for (const pendingPath of cache.pending.keys()) {
    if (isSameOpenClawAgentDatabasePath(pendingPath, resolvedPath)) {
      revokePendingAgentDatabaseOpen(pendingPath);
    }
  }
  for (const retained of cache.retainedCloses) {
    if (isSameOpenClawAgentDatabasePath(retained.path, resolvedPath)) {
      retained.close();
    }
  }
  // Disposal can be followed by file deletion or recreation, so revalidate next open.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  const matchingDatabases = [...cache.databases.values()].filter((candidate) =>
    isSameOpenClawAgentDatabasePath(candidate.path, resolvedPath),
  );
  if (matchingDatabases.length > 1) {
    return false;
  }
  const database = matchingDatabases[0];
  if (database && cache.incognito.has(database)) {
    return closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (!database) {
    return false;
  }
  try {
    unregisterOpenClawAgentDatabase({
      agentId: database.agentId,
      path: database.path,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  return true;
}

export { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";

/** Release fixture handles and pathname trust before a test root is recreated. */
export function closeOpenClawAgentDatabasesForTest(rootPath?: string): void {
  closeOpenClawAgentDatabases(rootPath);
  clearOpenClawAgentDatabaseValidationCache(rootPath);
  cache.terminal.clearAll(rootPath);
}

export {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabasesAsync,
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentDatabase,
  listOpenIncognitoAgentDatabases,
  readOpenIncognitoAgentDatabaseGeneration,
  settleOpenClawAgentDatabaseWorkerClose,
  type OpenClawAgentDatabaseWorkerCloseResult,
} from "./openclaw-agent-db-lifecycle.js";
