import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { prepareSqliteDatabaseDirectory } from "../infra/sqlite-wal-filesystem.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  assertAgentCreationClaimAccess,
  assertAgentCreationClaimAliases,
  assertAgentCreationClaimCurrent,
  registerAgentCreationClaimHandle,
  reserveAgentCreationClaimAdmission,
} from "./agent-creation-claim.js";
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
  OpenClawAgentDatabaseRegistrationObserver,
  OpenClawAgentDatabaseRepairAdmission,
} from "./openclaw-agent-db-contract.js";
import {
  assertOpenClawAgentDatabaseIdentity,
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
  resolveAgentDatabaseIntegrityGateReason,
  closeCachedOpenClawAgentDatabase,
  closeMaintenanceAgentDatabase,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  refreshAgentDatabaseIdleTimer,
  retainAgentDatabase,
  retainIncognitoSharedState,
  retainFailedAgentDatabaseClose,
  revokePendingAgentDatabaseOpen,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-scope.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
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
import { assertAgentDatabaseTerminalOpenAllowed } from "./openclaw-agent-db-terminal.js";
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
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { registerOpenClawAgentWalMaintenance } from "./openclaw-agent-db.wal.js";
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
export { deferOpenClawAgentPostCommitPublication } from "./openclaw-agent-db-lifecycle.js";
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

export type { OpenClawAgentDatabaseWriteAdmission } from "./openclaw-agent-db-admission.js";
export const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  withOpenClawAgentDatabaseAdmission,
} = createOpenClawAgentDatabaseAdmissionOwner(openOpenClawAgentDatabaseSteps);

function* openOpenClawAgentDatabaseSteps(
  options: OpenClawAgentDatabaseOptions,
  pending?: PendingAgentDatabaseOpen,
  preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
  registrationObserver?: OpenClawAgentDatabaseRegistrationObserver,
  repairAdmission?: OpenClawAgentDatabaseRepairAdmission,
): SqliteIntegrityOperation<OpenClawAgentDatabase> {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  const assertCurrent = (database?: Pick<OpenClawAgentDatabase, "db" | "path">) => {
    repairAdmission?.assertCurrent?.();
    if (repairAdmission?.expectedIdentity) {
      if (database) {
        assertOpenClawAgentDatabaseIdentity(database, repairAdmission.expectedIdentity);
      } else {
        assertExistingDatabaseIdentity(
          pathname,
          repairAdmission.expectedIdentity.key,
          repairAdmission.expectedIdentity.birthtime,
        );
      }
    }
  };
  assertCurrent();
  assertAgentCreationClaimCurrent(databaseOptions);
  getAgentDeletionDatabaseCleanup(databaseOptions)?.assertCurrent();
  const incognito = isIncognitoOpenClawAgentSqlitePath(pathname, databaseOptions);
  // A live successful cache entry is authoritative; failed entries remain only for disposal.
  const opened = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  if (opened) {
    assertCurrent(opened);
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
    if (!isMainThread) {
      // Worker-owned incognito must never spill SQLite temporary content to disk.
      db.exec("PRAGMA temp_store=MEMORY");
      // sqlite-allow-raw -- Admit the memory-only policy before schema work can use temporary pages.
      if (db.prepare("PRAGMA temp_store").get()?.temp_store !== 2) {
        throw new Error("Incognito actor requires memory-only SQLite temporary storage");
      }
    }
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
    admitSqliteSchema(db);
    registerOpenClawAgentDatabaseIdentity(db);
    const database = { agentId, db, path: pathname, walMaintenance };
    cache.incognito.add(database);
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    cache.databases.set(pathname, database);
    cache.generation += 1;
    registerNodeSqliteDisposeCallback(db, retainIncognitoSharedState(options.env));
    getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
      closeMaintenanceAgentDatabase(database),
    );
    return database;
  }
  if (!repairAdmission?.expectedIdentity) {
    quarantineOrphanedSqliteSidecars(pathname);
  }
  // Latched paths are quarantined; every fresh open fails fast here until
  // doctor repairs the file and clears the latch plus the persisted row.
  assertAgentDatabaseTerminalOpenAllowed(pathname);
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
    ...(options.env ?? process.env),
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
  let reuseIntegrity = false;
  let integrityRevoked = false;
  const validation = pending?.validation ?? preparedLease?.validation;
  const captureVerification: OpenClawAgentIntegrityVerificationReceiver = (
    record,
    runtimeIntegrityAllowed,
    invalidated,
  ) => {
    verification = record;
    reuseIntegrity = runtimeIntegrityAllowed;
    integrityRevoked = invalidated;
    if (invalidated && validation) {
      // Stale-peer cleanup precedes adoption of proof already transferred by the host.
      Atomics.store(new Int32Array(validation.valid), 0, 0);
    }
  };
  const releaseOptions = { env: leaseEnvironment, initializationAgentPaths: [pathname] };
  assertCurrent();
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
  let releaseCreationAdmission: (() => void) | undefined;
  try {
    assertCurrent();
    if (!repairAdmission?.expectedIdentity) {
      ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
      prepareSqliteDatabaseDirectory(pathname);
    }
    closeIdleOpenClawAgentDatabaseReadOnly(pathname);
    // Ordinary agent state also works with SQLite builds that omit extensions.
    // Trusted borrowers may enable them only when both the runtime and permissions allow it.
    const db = openNodeSqliteDatabase(
      repairAdmission?.expectedIdentity ? resolveExistingSqliteFileUri(pathname) : pathname,
      { allowExtension },
    );
    openedDb = db;
    registerOpenClawAgentDatabaseIdentity(db);
    assertCurrent({ db, path: pathname });
    if (repairAdmission?.expectedIdentity) {
      ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    }
    db.enableLoadExtension(false);
    enableNodeSqliteKyselyStatementCache(db);
    if (preparedLease) {
      // Worker TEMP policy precedes schema/session caches and any exposed connection.
      db.exec("PRAGMA temp_store = FILE");
    }
    finishPhase("open");
    // Eviction churn must avoid migration/convergence and registry busy waits.
    // Version and owner can change while evicted, so their read-only gates run on every open.
    const validationDatabase = { db, path: pathname, agentId };
    if (validation) {
      adoptOpenClawAgentDatabaseValidation(validationDatabase, validation);
    }
    let isValidatedReopen = Boolean(getOpenClawAgentDatabaseValidation(validationDatabase));
    let walMaintenance: SqliteWalMaintenance;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSupportedAgentSchemaVersion(db, pathname);
      const existingSchema = readExistingAgentSchemaMeta(db);
      assertExistingAgentSchemaOwner(existingSchema, agentId, pathname);
      if (pending) {
        releaseCreationAdmission = reserveAgentCreationClaimAdmission(
          pending,
          databaseOptions,
          async () => {
            await closeOpenClawAgentDatabaseByPathAsync(pathname, agentId);
          },
        );
      }
      // Runtime proof survives last-lease close; cold opens require clean-close proof.
      // Runtime proof carries owner revocation; every open still checks schema convergence.
      diagnostics.integrityGateReason = resolveAgentDatabaseIntegrityGateReason(
        validationDatabase,
        { verification, validation, integrityRevoked, reuseIntegrity },
      );
      const requiresCurrentVersionConvergence = yield* agentDatabaseIntegrityBeforeMutationSteps(
        db,
        agentId,
        pathname,
        diagnostics,
        verification,
        isValidatedReopen && reuseIntegrity,
      );
      assertCurrent(validationDatabase);
      if (!diagnostics.integrityGateOutcome || diagnostics.integrityGateOutcome === "cached") {
        delete diagnostics.integrityGateReason;
      }
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
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: `openclaw-agent:${agentId}`,
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      openedWalMaintenance = walMaintenance;
      finishPhase("configuration");
      assertCurrent(validationDatabase);
      if (!isValidatedReopen) {
        ensureOpenClawAgentSchema(db, agentId, pathname);
      }
      finishPhase("schema");
    } catch (err) {
      if (diagnostics.integrityGateOutcome === "failed") {
        finishPhase("validation");
      }
      openedWalMaintenance?.close();
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
    assertCurrent({ db, path: pathname });
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    admitSqliteSchema(db);
    const database = { agentId, db, path: pathname, walMaintenance };
    openedDatabase = database;
    if (hasAgentDatabaseMaintenanceAuthority()) {
      throw new Error(
        "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
      );
    }
    registerAgentDeletionDatabaseCleanup(database, databaseOptions)?.registerClose(
      createScopeOwnedClose(database, "Agent deletion cleanup"),
    );
    registerAgentCreationClaimHandle(database, databaseOptions)?.registerClose(
      createScopeOwnedClose(database, "Agent creation claim"),
    );
    if (!isValidatedReopen) {
      assertCurrent(database);
      registerOpenClawAgentDatabase(
        { agentId, path: pathname, env: options.env },
        registrationObserver,
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
    assertCurrent(database);
    if (diagnostics.integrityGateOutcome === "cached" && !(isValidatedReopen && reuseIntegrity)) {
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
    } else if (diagnostics.integrityGateOutcome !== "cached" && typeof identity === "string") {
      recordOpenClawAgentDatabaseIntegrityVerified(
        leaseId,
        { agentId, path: pathname, env: leaseEnvironment },
        identity,
      );
    }
    refreshAgentDatabaseIdleTimer(database);
    if (isMainThread) {
      registerOpenClawAgentWalMaintenance(database, leaseEnvironment);
    }
    getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
      closeMaintenanceAgentDatabase(database),
    );
    releaseCreationAdmission?.();
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
          releaseOpenClawAgentDatabaseLease(leaseId, releaseOptions);
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
            stop: async () => {},
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
        releaseOpenClawAgentDatabaseLease(leaseId, releaseOptions);
      } catch (releaseError) {
        retainFailedAgentDatabaseClose(agentId, pathname, () =>
          releaseOpenClawAgentDatabaseLease(leaseId, releaseOptions),
        );
        throw releaseError;
      }
    }
    throw closeError ?? error;
  }
}

/** A lifecycle scope closes its exact connection and retains its borrow until disposal succeeds. */
function createScopeOwnedClose(
  database: OpenClawAgentDatabase,
  owner: string,
): () => Promise<void> {
  const release = retainAgentDatabase(database.db);
  return async () => {
    if (cache.databases.get(database.path) === database) {
      await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    } else if (database.db.isOpen) {
      throw new Error(`${owner} lost its database close owner.`);
    }
    release();
  };
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
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  // Incognito skips durable database leases, but still follows the agent deletion fence.
  if (
    isIncognitoOpenClawAgentSqlitePath(pathname, options) &&
    readAgentDeletionJournal(agentId, { env: options.env }, "runtime")
  ) {
    throw new Error(`OpenClaw agent database is unavailable while agent ${agentId} is deleted.`);
  }
  const database = cache.databases.get(pathname);
  if (!database?.db.isOpen) {
    assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
    assertAgentCreationClaimAliases(options, isSameOpenClawAgentDatabasePath);
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
  assertAgentCreationClaimAccess(database, options);
  observeOpenClawDatabaseMaintenanceResource(database.db);
  refreshAgentDatabaseIdleTimer(database);
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
  disposeOpenClawAgentDatabaseByPath,
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentDatabase,
  listOpenIncognitoAgentDatabases,
  readOpenIncognitoAgentDatabaseGeneration,
  settleOpenClawAgentDatabaseWorkerClose,
  type OpenClawAgentDatabaseWorkerCloseResult,
} from "./openclaw-agent-db-lifecycle.js";
