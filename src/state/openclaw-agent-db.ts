import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { assertEngineStoreExecutionAllowed } from "../infra/database-engine/admission-scope.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
import {
  isPostgresSqlConnection,
  sqlPublicationAnchor,
  type EngineConnection,
} from "../infra/sql-connection.js";
import {
  readSqliteDatabaseIntegrityVerification,
  readSqliteDatabaseCleanCloseRefusal,
} from "../infra/sqlite-database-admission.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
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
import { SqliteWorkerOpenRefusedError } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  assertAgentCreationClaimCurrent,
  registerAgentCreationClaimHandle,
  reserveAgentCreationClaimAdmission,
} from "./agent-creation-claim.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  getAgentDeletionDatabaseCleanup,
  registerAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { createOpenClawAgentDatabaseAdmissionOwner } from "./openclaw-agent-db-admission.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  retainAgentDatabase,
} from "./openclaw-agent-db-borrower.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseRegistrationObserver,
  OpenClawAgentDatabaseRepairAdmission,
} from "./openclaw-agent-db-contract.js";
import { agentEngineInput, openAgentEngineStore } from "./openclaw-agent-db-engine.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  agentDatabaseAdmissionProvenanceRefusal,
  readAgentDatabaseLeaseProvenance,
} from "./openclaw-agent-db-lease-provenance.js";
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
  hasRevokedOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { registerOpenClawAgentWalMaintenance } from "./openclaw-agent-db.wal.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

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
  openOpenClawAgentDatabaseInWorker,
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
  const engineInput = agentEngineInput();
  const integrityCheck = engineInput
    ? undefined
    : (repairAdmission?.integrityCheck ??
      getOpenClawDatabaseMaintenanceScope()?.sqliteIntegrityCheck);
  if (engineInput) {
    assertEngineStoreExecutionAllowed();
  }
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
  let reuseIntegrity = false;
  let liveOwnerProvenance: string | undefined;
  let integrityRevoked = false;
  let processDeath = false;
  const diagnostics: SqliteIntegrityDiagnostics = {};
  const validation = pending?.validation ?? preparedLease?.validation;
  const previouslyRevoked =
    preparedLease?.integrityRevoked === true ||
    pending?.integrityRevoked === true ||
    hasRevokedOpenClawAgentDatabaseValidation(pathname, validation);
  const claimProvenance = preparedLease
    ? preparedLease.provenance
    : readAgentDatabaseLeaseProvenance(pathname);
  const captureVerification: OpenClawAgentIntegrityVerificationReceiver = (
    runtimeIntegrityAllowed,
    invalidated,
    because,
    admittedFileProvenance,
  ) => {
    reuseIntegrity = runtimeIntegrityAllowed;
    liveOwnerProvenance = admittedFileProvenance;
    processDeath =
      invalidated && runtimeIntegrityAllowed && !previouslyRevoked && because === undefined;
    // A host refusal may have no positive validation receipt to transfer.
    integrityRevoked =
      invalidated || preparedLease?.integrityRevoked === true || pending?.integrityRevoked === true;
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
  let openedDb: EngineConnection | undefined;
  let openedDatabase: OpenClawAgentDatabase | undefined;
  let openedWalMaintenance: SqliteWalMaintenance | undefined;
  let releaseCreationAdmission: (() => void) | undefined;
  try {
    assertCurrent();
    if (preparedLease && !isMainThread) {
      try {
        // Capture proof after stale-lease cleanup, but refuse before opening a native writer.
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: { kind: "agent-validation-start", lease: preparedLease.receipt },
        });
      } catch (error) {
        throw new SqliteWorkerOpenRefusedError(error);
      }
    }
    if (!repairAdmission?.expectedIdentity) {
      ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
      prepareSqliteDatabaseDirectory(pathname);
    }
    closeIdleOpenClawAgentDatabaseReadOnly(pathname);
    // Ordinary agent state also works with SQLite builds that omit extensions.
    // Trusted borrowers may enable them only when both the runtime and permissions allow it.
    const db = openNodeSqliteDatabase(
      repairAdmission?.expectedIdentity ? resolveExistingSqliteFileUri(pathname) : pathname,
      { allowExtension, timeout: engineInput ? undefined : OPENCLAW_SQLITE_BUSY_TIMEOUT_MS },
    );
    openedDb = db;
    let selected: EngineConnection = db;
    registerOpenClawAgentDatabaseIdentity(db, resolveOpenClawStateSqlitePath(leaseEnvironment));
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
    if (validation && !engineInput) {
      adoptOpenClawAgentDatabaseValidation(validationDatabase, validation);
    }
    let isValidatedReopen = Boolean(getOpenClawAgentDatabaseValidation(validationDatabase));
    // Lease history governs first admission; it cannot expire this process's checked file.
    const reuseAdmittedIntegrity =
      reuseIntegrity || (pending?.workerPrepared === true && !integrityRevoked);
    let reusedSchema = false;
    let walMaintenance: SqliteWalMaintenance;
    try {
      if (engineInput) {
        if (pending) {
          releaseCreationAdmission = reserveAgentCreationClaimAdmission(
            pending,
            databaseOptions,
            async () => {
              await closeOpenClawAgentDatabaseByPathAsync(pathname, agentId);
            },
          );
        }
        selected = openAgentEngineStore(db, agentId, pathname, false, (connection, error) => {
          selected = openedDb = connection;
          throw error;
        });
        openedDb = selected;
        walMaintenance = {
          checkpoint: () => false,
          stop: async () => {},
          reclaimFreePages: createSqliteWalReclamationResult,
          close: () => true,
        };
        setOpenClawAgentDatabaseValidation({ db: selected, path: pathname, agentId });
        isValidatedReopen = true;
        reusedSchema = true;
      } else {
        reusedSchema = adoptOpenClawAgentDatabaseSchema(
          validationDatabase,
          reuseAdmittedIntegrity,
          pending?.workerPrepared,
        );
        if (!reusedSchema) {
          admitSqliteSchema(db, (userVersion) => {
            assertSupportedAgentSchemaVersion(db, pathname, userVersion);
          });
        }
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
        // The host grant can revoke transferred proof; decide reuse after it returns.
        diagnostics.integrityGateReason = integrityRevoked
          ? processDeath &&
            claimProvenance !== null &&
            readAgentDatabaseLeaseProvenance(pathname) === claimProvenance
            ? "process-death"
            : "stale-lease-full"
          : hasRevokedOpenClawAgentDatabaseValidation(pathname, validation)
            ? "revoked"
            : reuseIntegrity
              ? (readSqliteDatabaseCleanCloseRefusal(db) ?? "no-proof")
              : "lease-class";
        diagnostics.because ??=
          diagnostics.integrityGateReason === "stale-lease-full"
            ? agentDatabaseAdmissionProvenanceRefusal(preparedLease?.provenance, pathname)
            : undefined;
        let verification: { verifiedAt: number } | undefined;
        if (
          diagnostics.integrityGateReason === "revoked" ||
          diagnostics.integrityGateReason === "process-death" ||
          diagnostics.integrityGateReason === "stale-lease-full"
        ) {
          isValidatedReopen = false;
          reusedSchema = false;
        } else if (reuseIntegrity) {
          // Path admission can precede replacement detection; borrow only this native file's proof.
          verification = readSqliteDatabaseIntegrityVerification(db);
        }
        if (
          integrityCheck !== "quick" &&
          (integrityCheck === "full" ||
            !["process-death", "lease-class", "no-proof"].includes(diagnostics.integrityGateReason))
        ) {
          // A missing seal alone is not corruption evidence; known refusals must survive death.
          recordOpenClawAgentDatabaseAdmission(
            leaseId,
            { agentId, path: pathname, env: leaseEnvironment },
            "full-required",
          );
        }
        const requiresCurrentVersionConvergence = yield* agentDatabaseIntegrityBeforeMutationSteps(
          db,
          agentId,
          pathname,
          diagnostics,
          verification,
          (isValidatedReopen && reuseAdmittedIntegrity) ||
            (diagnostics.integrityGateReason === "lease-class" &&
              liveOwnerProvenance !== undefined &&
              // Re-read after the native open: the claim's file must be the one this handle opened.
              readAgentDatabaseLeaseProvenance(pathname) === liveOwnerProvenance),
          reusedSchema,
          integrityCheck,
          repairAdmission?.integrityTables ?? [],
          preparedLease?.startupIntegrity,
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
          // Native workers already checkpoint on maintenance ticks, outside foreground commits.
          autoCheckpointPages: 0,
          databaseLabel: `openclaw-agent:${agentId}`,
          databasePath: pathname,
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        openedWalMaintenance = walMaintenance;
        finishPhase("configuration");
        assertCurrent(validationDatabase);
        if (!isValidatedReopen) {
          ensureOpenClawAgentSchema(
            db,
            agentId,
            pathname,
            undefined,
            undefined,
            undefined,
            false,
            integrityCheck,
          );
        }
        finishPhase("schema");
        selected = openAgentEngineStore(db, agentId, pathname);
      }
    } catch (err) {
      if (diagnostics.integrityGateOutcome === "failed") {
        finishPhase("validation");
      }
      openedWalMaintenance?.close();
      if (selected.isOpen) {
        selected.close();
      }
      if (isPostgresSqlConnection(selected) && db.isOpen) {
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
    assertCurrent({ db: selected, path: pathname });
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    if (!reusedSchema) {
      admitSqliteSchema(db);
      assertCanonicalSessionValidationSchema(db);
    }
    const database = { agentId, db: selected, path: pathname, walMaintenance };
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
        {
          agentId,
          path: pathname,
          env: options.env,
          // Bounded admission retains process proof without minting a FULL receipt or seal.
          // Temporary QUICK repair handles still cannot publish runtime admission.
          admittedDb:
            integrityCheck === "quick" && diagnostics.integrityGateOutcome !== "pending"
              ? undefined
              : selected,
        },
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
    registerAgentDatabaseHandle(database, leaseId, leaseEnvironment);
    assertCurrent(database);
    recordOpenClawAgentDatabaseAdmission(leaseId, {
      agentId,
      path: pathname,
      env: leaseEnvironment,
    });
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
    // The host releases a refused prepared worker's lease after native exit.
    const deferLeaseRelease =
      preparedLease !== undefined && !isMainThread && error instanceof SqliteWorkerOpenRefusedError;
    let closeError: unknown;
    if (openedDatabase) {
      try {
        closeCachedOpenClawAgentDatabase(openedDatabase);
      } catch (caught) {
        closeError = caught;
      }
    }
    if (openedDb && (openedDb.isOpen || sqlPublicationAnchor(openedDb).isOpen)) {
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
          const anchor = sqlPublicationAnchor(retainedDb);
          if (isPostgresSqlConnection(retainedDb) && anchor.isOpen) {
            anchor.close();
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
    } else if (!deferLeaseRelease) {
      const closeOutcome = error instanceof SqliteWorkerOpenRefusedError ? "read-only" : undefined;
      try {
        releaseOpenClawAgentDatabaseLease(leaseId, releaseOptions, closeOutcome);
      } catch (releaseError) {
        retainFailedAgentDatabaseClose(agentId, pathname, () =>
          releaseOpenClawAgentDatabaseLease(leaseId, releaseOptions, closeOutcome),
        );
        throw releaseError;
      }
    }
    throw closeError ?? error;
  }
}

/** Retain the exact verified connection across awaits; explicit disposal still revokes it. */
export function borrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions): {
  db: EngineConnection;
  release: () => void;
} {
  const { db } = openOpenClawAgentDatabase(options);
  return { db, release: retainAgentDatabase(db) };
}

export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  return cache.databases.get(path.resolve(pathname))?.db.isOpen === true;
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
  settleOpenClawAgentDatabaseWorkerClose,
} from "./openclaw-agent-db-lifecycle.js";

export { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db-borrower.js";
export { inspectOpenClawAgentDatabaseOwner } from "./openclaw-agent-db-owner-read.js";
