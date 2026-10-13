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
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
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
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
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
import { agentDatabaseAdmissionProvenanceRefusal } from "./openclaw-agent-db-lease-provenance.js";
import {
  hasAgentDatabaseMaintenanceAuthority,
  assertOpenClawAgentDatabaseLease,
  claimOpenClawAgentDatabaseLease,
  recordOpenClawAgentDatabaseAdmission,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentIntegrityVerificationReceiver,
  type prepareOpenClawAgentDatabaseWorkerLease,
} from "./openclaw-agent-db-lease.js";
import {
  agentDatabaseLifecycle as cache,
  startAgentDatabaseOpenTiming,
  recordOpenClawAgentDatabaseOpenFailure,
  closeCachedOpenClawAgentDatabase,
  createAgentDatabaseScopeOwnedClose,
  closeMaintenanceAgentDatabase,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  refreshAgentDatabaseIdleTimer,
  registerAgentDatabaseHandle,
  retainAgentDatabase,
  retainIncognitoSharedState,
  retainFailedAgentDatabaseClose,
  revokePendingAgentDatabaseOpen,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-scope.js";
import { hasRegisteredOpenClawAgentDatabasePath } from "./openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  assertAgentDatabaseResourceAdmission,
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "./openclaw-agent-db-resources.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertCurrentAgentSchemaMetadata,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  agentDatabaseIntegrityBeforeMutationSteps,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { revalidateAgentDatabaseTerminalOpen } from "./openclaw-agent-db-terminal.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  adoptOpenClawAgentDatabaseSchema,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  publishOpenClawAgentDatabaseSchema,
} from "./openclaw-agent-db-validation-cache.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  isIncognitoOpenClawAgentSqlitePath,
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { registerOpenClawAgentWalMaintenance } from "./openclaw-agent-db.wal.js";
import { requestOpenClawAgentDatabaseIntegrityCheck } from "./openclaw-database-verify.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
  resolveAgentDatabaseIntegrityGateReason,
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

/** Drain the live owner before reconfirming an advisory failure in a native child. */
export async function confirmOpenClawAgentDatabaseIntegrity(
  pathname: string,
  lifetime?: import("./openclaw-database-verify.impl.js").DatabaseVerifyWorkerLifetime,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = path.resolve(pathname);
  await closeOpenClawAgentDatabaseByPathAsync(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  const { confirmDatabaseVerifyWorker } = await import("./openclaw-database-verify.impl.js");
  return confirmDatabaseVerifyWorker(
    { path: resolvedPath, kind: "agent", label: resolvedPath },
    lifetime,
  );
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
  withOpenClawAgentDatabaseRuntime,
  withOpenClawAgentDatabaseRuntimeFromExecution,
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
    if (pending?.workerPrepared) {
      adoptOpenClawAgentDatabaseSchema(opened, true, true);
    }
    return opened;
  }
  assertAgentDatabaseResourceAdmission({ agentId, path: pathname });
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
    assertCanonicalSessionValidationSchema(db);
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
  revalidateAgentDatabaseTerminalOpen(pathname);
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
  const diagnostics: SqliteIntegrityDiagnostics = {};
  const validation = pending?.validation ?? preparedLease?.validation;
  const captureVerification: OpenClawAgentIntegrityVerificationReceiver = (
    record,
    runtimeIntegrityAllowed,
    invalidated,
    because,
  ) => {
    verification = record;
    reuseIntegrity = runtimeIntegrityAllowed;
    integrityRevoked = invalidated;
    diagnostics.because = invalidated ? because : undefined;
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
    // Physical admission survives idle connection retirement for the process lifetime.
    const validationDatabase = { db, path: pathname, agentId };
    if (validation) {
      adoptOpenClawAgentDatabaseValidation(validationDatabase, validation);
    }
    let isValidatedReopen = Boolean(getOpenClawAgentDatabaseValidation(validationDatabase));
    // Lease history governs first admission; it cannot expire this process's checked file.
    const reuseAdmittedIntegrity =
      isValidatedReopen ||
      reuseIntegrity ||
      (pending?.workerPrepared === true && !integrityRevoked);
    let reusedSchema = false;
    let walMaintenance: SqliteWalMaintenance;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      reusedSchema = adoptOpenClawAgentDatabaseSchema(
        validationDatabase,
        reuseAdmittedIntegrity,
        pending?.workerPrepared,
      );
      assertSupportedAgentSchemaVersion(db, pathname);
      const existingSchema = readExistingAgentSchemaMeta(db);
      assertExistingAgentSchemaOwner(existingSchema, agentId, pathname);
      if (reusedSchema) {
        assertCurrentAgentSchemaMetadata(existingSchema, agentId, pathname);
      }
      if (pending) {
        releaseCreationAdmission = reserveAgentCreationClaimAdmission(
          pending,
          databaseOptions,
          async () => {
            await closeOpenClawAgentDatabaseByPathAsync(pathname, agentId);
          },
        );
      }
      // Explicit corruption and repair still revoke physical admission.
      diagnostics.integrityGateReason = resolveAgentDatabaseIntegrityGateReason(
        validationDatabase,
        { verification, validation, integrityRevoked, reuseIntegrity },
      );
      diagnostics.because ??= integrityRevoked
        ? agentDatabaseAdmissionProvenanceRefusal(preparedLease?.provenance, pathname)
        : undefined;
      if (preparedLease && !isMainThread) {
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: { kind: "agent-validation-start", lease: preparedLease.receipt },
        });
      }
      const requiresCurrentVersionConvergence = yield* agentDatabaseIntegrityBeforeMutationSteps(
        db,
        agentId,
        pathname,
        diagnostics,
        verification,
        isValidatedReopen && reuseAdmittedIntegrity,
        integrityRevoked && !diagnostics.because,
        reusedSchema,
        preparedLease?.deferUnverifiedIntegrity,
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
    if (!reusedSchema) {
      admitSqliteSchema(db);
      assertCanonicalSessionValidationSchema(db);
    }
    const database = { agentId, db, path: pathname, walMaintenance };
    openedDatabase = database;
    if (hasAgentDatabaseMaintenanceAuthority()) {
      throw new Error(
        "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
      );
    }
    registerAgentDeletionDatabaseCleanup(database, databaseOptions)?.registerClose(
      createAgentDatabaseScopeOwnedClose(database, "Agent deletion cleanup"),
    );
    registerAgentCreationClaimHandle(database, databaseOptions)?.registerClose(
      createAgentDatabaseScopeOwnedClose(database, "Agent creation claim"),
    );
    if (
      !isValidatedReopen ||
      !hasRegisteredOpenClawAgentDatabasePath(database, { env: options.env })
    ) {
      assertCurrent(database);
      registerOpenClawAgentDatabase(
        { agentId, path: pathname, env: options.env, admittedDb: db },
        registrationObserver,
      );
    } else if (!reusedSchema) {
      publishOpenClawAgentDatabaseSchema(database);
    }
    cache.terminal.clear(pathname);
    // Safety net for processes that end without an orderly close: agent DBs have
    // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    finishPhase("registration");
    const deferred = diagnostics.integrityGateMode === "deferred";
    registerAgentDatabaseHandle(database, leaseId, leaseEnvironment, deferred);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    assertCurrent(database);
    if (deferred || (diagnostics.integrityGateOutcome === "cached" && !isValidatedReopen)) {
      const check = deferred ? "full" : "quick";
      if (preparedLease) {
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: {
            kind: "agent-integrity-check",
            lease: preparedLease.receipt,
            check,
          },
        });
      } else {
        requestOpenClawAgentDatabaseIntegrityCheck({
          path: pathname,
          env: leaseEnvironment,
          check,
        });
      }
    }
    if (typeof identity === "string") {
      recordOpenClawAgentDatabaseAdmission(
        leaseId,
        { agentId, path: pathname, env: leaseEnvironment },
        identity,
        !deferred && diagnostics.integrityGateOutcome !== "cached",
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
      const successor = cache.databases.get(pathname);
      if (pending && successor && successor.db !== openedDb) {
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

/** Retain the exact verified connection across awaits; explicit disposal still revokes it. */
export function borrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions): {
  db: DatabaseSync;
  release: () => void;
} {
  const { db } = openOpenClawAgentDatabase(options);
  return { db, release: retainAgentDatabase(db) };
}

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
  if (isIncognitoOpenClawAgentSqlitePath(pathname, options)) {
    const journal = readAgentDeletionJournal(agentId, { env: options.env }, "runtime");
    if (journal && (journal.phase !== "draining" || journal.cleanupCompleted)) {
      throw new Error(`OpenClaw agent database is unavailable while agent ${agentId} is deleted.`);
    }
  }
  const database = cache.databases.get(pathname);
  if (!database?.db.isOpen) {
    assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
    assertAgentCreationClaimAliases(options);
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

export {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentDatabase,
  listOpenIncognitoAgentDatabases,
  readOpenIncognitoAgentDatabaseGeneration,
  recordOpenClawAgentDatabaseOpenFailure,
  settleOpenClawAgentDatabaseWorkerClose,
} from "./openclaw-agent-db-lifecycle.js";
