import { addAbortListener } from "node:events";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { isPathInside } from "../infra/path-guards.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteDatabaseSiblingWriteRevision } from "../infra/sqlite-database-admission.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import {
  deferSqlitePostCommitPublication,
  hasSqlitePostCommitScope,
} from "../infra/sqlite-post-commit.js";
import {
  invalidateSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayShutdownCleanupSignal } from "../process/gateway-work-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { releaseAgentCreationClaimHandle } from "./agent-creation-claim.js";
import { releaseAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import {
  readOpenClawAgentDatabaseIdentity,
  findOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "./openclaw-agent-db-identity.js";
import {
  assertAgentDatabaseMaintenanceAuthority,
  hasAgentDatabaseMaintenanceAuthority,
  readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim,
  recordOpenClawAgentDatabaseAdmission,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import {
  drainAgentDatabaseResources,
  matchesAgentDatabaseClose,
  revokeAgentDatabaseResources,
  withAgentDatabaseCloseFence,
  type AgentDatabaseCloseSelection,
} from "./openclaw-agent-db-resources.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

const agentDbLog = createSubsystemLogger("state/agent-db");
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;
// Native and transformed SDK graphs must share the complete owner lifecycle;
// sharing only handles would split borrow pins, failure latches, and cleanup.
type AgentDatabaseLifecycle = {
  databases: Map<string, OpenClawAgentDatabase>;
  borrowers: WeakMap<DatabaseSync, Set<object>>;
  idleTimers: WeakMap<DatabaseSync, Disposable & { refresh(): void }>;
  failures: Map<string, unknown>;
  leases: Map<
    string,
    {
      leaseId: string;
      env: NodeJS.ProcessEnv;
      verification?: { writeRevision: number; validation: OpenClawAgentDatabaseValidation };
    }
  >;
  terminal: ReturnType<typeof createSqliteTerminalOpenLatch>;
  unregisterExitClose: (() => void) | null;
  pending: Map<string, PendingAgentDatabaseOpen>;
  activePending: Set<PendingAgentDatabaseOpen>;
  retainedCloses: Set<RetainedAgentDatabaseClose>;
};
export type PendingAgentDatabaseOpen = {
  agentId: string;
  path: string;
  controller: AbortController;
  promise: Promise<OpenClawAgentDatabase>;
  assertHeld?: () => void;
  operations: number;
  releaseBorrow?: () => void;
  validation?: OpenClawAgentDatabaseValidation;
  workerPrepared?: boolean;
};
type RetainedAgentDatabaseClose = { agentId: string; path: string; close: () => void };
const cache = resolveGlobalSingleton<AgentDatabaseLifecycle>(
  Symbol.for("openclaw.agentDatabaseLifecycle"),
  () => ({
    databases: new Map(),
    borrowers: new WeakMap(),
    idleTimers: new WeakMap(),
    failures: new Map(),
    leases: new Map(),
    terminal: createSqliteTerminalOpenLatch({
      closeByPath: (pathname) => closeOpenClawAgentDatabaseByPath(pathname),
    }),
    unregisterExitClose: null,
    pending: new Map(),
    activePending: new Set(),
    retainedCloses: new Set(),
  }),
);

export function registerAgentDatabaseHandle(
  database: OpenClawAgentDatabase,
  leaseId: string,
  env: NodeJS.ProcessEnv,
  deferred: boolean,
): void {
  const validation = deferred ? getOpenClawAgentDatabaseValidation(database) : undefined;
  const writeRevision = validation
    ? readSqliteDatabaseSiblingWriteRevision(database.db)
    : undefined;
  cache.leases.set(database.path, {
    leaseId,
    env,
    ...(validation && writeRevision !== undefined
      ? { verification: { writeRevision, validation } }
      : {}),
  });
  cache.databases.set(database.path, database);
}

/** Only the original writer can promote its background scan into durable proof. */
export function recordOpenClawAgentDatabaseBackgroundVerification(
  database: OpenClawAgentDatabase,
  beforePublication: () => void,
): boolean {
  const lease = cache.leases.get(database.path);
  const witness = lease?.verification;
  if (!lease || !witness || cache.databases.get(database.path) !== database) {
    return false;
  }
  lease.verification = undefined;
  return runSqliteImmediateTransactionSync(database.db, () => {
    beforePublication();
    // The writer lock keeps the captured committed revision current through publication.
    if (
      Atomics.load(new Int32Array(witness.validation.valid), 0) !== 1 ||
      !isOpenClawAgentDatabasePathCurrent(database) ||
      readSqliteDatabaseSiblingWriteRevision(database.db) !== witness.writeRevision
    ) {
      return false;
    }
    return recordOpenClawAgentDatabaseAdmission(
      lease.leaseId,
      { agentId: database.agentId, path: database.path, env: lease.env },
      witness.validation.identity,
      true,
    );
  });
}

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: (options: OpenClawAgentDatabaseOptions) => void,
): boolean {
  // Maintenance can mark projections dirty without scheduling runtime publication.
  if (!hasSqlitePostCommitScope(database.db)) {
    return false;
  }
  if (hasAgentDatabaseMaintenanceAuthority()) {
    assertAgentDatabaseMaintenanceAuthority();
    return false;
  }
  const lease = cache.leases.get(database.path);
  if (cache.databases.get(database.path) !== database || !lease) {
    throw new Error("Agent post-commit publication requires its admitted database owner");
  }
  const options = {
    agentId: database.agentId,
    path: database.path,
    env: { ...lease.env },
  };
  return deferSqlitePostCommitPublication(database.db, () => publish(options));
}

function logResourceCloseFailure(pathname: string, error: unknown): void {
  agentDbLog.warn("Agent database resource close failed", { path: pathname, error });
}

function unregisterUnusedAgentDatabaseExitClose(): void {
  if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
    cache.unregisterExitClose?.();
    cache.unregisterExitClose = null;
  }
}

/** Each physical-open generator owns these checkpoints across any integrity await. */
export function startAgentDatabaseOpenTiming(
  agentId: string,
  pathname: string,
  admissionMode: "sync" | "async",
  diagnostics: SqliteIntegrityDiagnostics,
) {
  const startedAt = performance.now();
  let elapsedMs = 0;
  const phaseDurationsMs = { open: 0, validation: 0, configuration: 0, schema: 0, registration: 0 };
  return (phase: keyof typeof phaseDurationsMs): void => {
    const completedMs = Math.floor(performance.now() - startedAt);
    phaseDurationsMs[phase] = completedMs - elapsedMs;
    elapsedMs = completedMs;
    if (phase === "validation" && diagnostics.integrityGateReason) {
      agentDbLog.info("agent database integrity gate", {
        agentId,
        path: pathname,
        pid: process.pid,
        threadId,
        isMainThread,
        admissionMode,
        ...diagnostics,
      });
    }
    // Registration is the final checkpoint; intermediate phases never emit a partial summary.
    if (phase === "registration" && elapsedMs >= OPENCLAW_AGENT_DB_SLOW_OPEN_MS) {
      agentDbLog.warn("slow OpenClaw agent database open", {
        agentId,
        elapsedMs,
        path: pathname,
        pid: process.pid,
        threadId,
        isMainThread,
        admissionMode,
        phaseDurationsMs,
        ...diagnostics,
        thresholdMs: OPENCLAW_AGENT_DB_SLOW_OPEN_MS,
      });
    }
  };
}

// A failed native close or lease release keeps its original owner until retry succeeds.
export function retainFailedAgentDatabaseClose(
  agentId: string,
  pathname: string,
  close: () => void,
): void {
  const retained: RetainedAgentDatabaseClose = {
    agentId,
    path: pathname,
    close: () => {
      close();
      cache.retainedCloses.delete(retained);
    },
  };
  cache.retainedCloses.add(retained);
  getOpenClawDatabaseMaintenanceScope()?.own(retained, "agent-handles", retained.close);
  cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
}

export function revokePendingAgentDatabaseOpen(pathname: string, expectedAgentId?: string): void {
  for (const pending of cache.activePending) {
    if (
      pending.path === pathname &&
      (expectedAgentId === undefined || pending.agentId === expectedAgentId)
    ) {
      pending.controller.abort(new Error(`Agent database open was revoked: ${pathname}`));
    }
  }
}

export function retainAgentDatabase(db: DatabaseSync): () => void {
  observeOpenClawDatabaseMaintenanceResource(db);
  const borrowers = cache.borrowers.get(db) ?? new Set<object>();
  const borrower = {};
  borrowers.add(borrower);
  cache.borrowers.set(db, borrowers);
  return () => {
    if (borrowers.delete(borrower) && borrowers.size === 0) {
      cache.idleTimers.get(db)?.refresh();
    }
  };
}

/** Activity and final borrower release use the same idle or post-grace eviction. */
export function refreshAgentDatabaseIdleTimer(database: OpenClawAgentDatabase): void {
  const existing = cache.idleTimers.get(database.db);
  if (existing) {
    existing.refresh();
    return;
  }
  const cleanupSignal = getGatewayShutdownCleanupSignal();
  const closeIdle = () => {
    if (cache.databases.get(database.path) !== database) {
      cache.idleTimers.get(database.db)?.[Symbol.dispose]();
      cache.idleTimers.delete(database.db);
      return;
    }
    // Awaiting operations own the exact connection; final release rearms eviction.
    if (database.db.isOpen && cache.borrowers.get(database.db)?.size) {
      return;
    }
    if (database.db.isOpen && database.db.isTransaction) {
      timer.refresh();
      return;
    }
    try {
      // Registry discovery metadata survives eviction; only explicit disposal removes it.
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      cache.databases.delete(database.path);
      cache.failures.delete(database.path);
      unregisterUnusedAgentDatabaseExitClose();
    } catch (error) {
      // Keep native/lease custody on the original entry until cleanup succeeds.
      logResourceCloseFailure(database.path, error);
      timer.refresh();
    }
  };
  const refresh = () => {
    if (cleanupSignal.aborted) {
      // A synchronous opener can still borrow the exact handle before cleanup runs.
      runInSqliteMaintenanceContext(() => queueMicrotask(closeIdle));
    } else {
      timer.refresh();
    }
  };
  const timer = runInSqliteMaintenanceContext(() =>
    setTimeout(closeIdle, SQLITE_IDLE_HANDLE_TTL_MS),
  );
  const cleanupListener = addAbortListener(cleanupSignal, refresh);
  timer.unref();
  cache.idleTimers.set(database.db, {
    refresh,
    [Symbol.dispose]() {
      clearTimeout(timer);
      cleanupListener[Symbol.dispose]();
    },
  });
}

/** Dispose only this publication; a later admission at the same path is independent. */
export async function closeMaintenanceAgentDatabase(
  database: OpenClawAgentDatabase,
): Promise<void> {
  await database.walMaintenance.stop();
  if (cache.databases.get(database.path) !== database) {
    return;
  }
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(database.path);
  cache.failures.delete(database.path);
}

export function closeCachedOpenClawAgentDatabase(
  database: OpenClawAgentDatabase,
  options: { eviction?: boolean } = {},
): void {
  // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
  // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
  const lease = cache.leases.get(database.path);
  const alreadyClosed = !database.db.isOpen;
  const priorCheckpointError = database.walMaintenance.health?.state === "error";
  let clean: { path: string; identity: string } | undefined;
  let retainRuntimeProof: boolean;
  try {
    disposeNodeSqliteDependents(database.db);
    const checkpointed = database.walMaintenance.close(
      options.eviction ? { checkpointMode: "PASSIVE" } : undefined,
    );
    if (
      checkpointed &&
      !cache.failures.has(database.path) &&
      isOpenClawAgentDatabasePathCurrent(database)
    ) {
      const { identity } = readOpenClawAgentDatabaseIdentity(database);
      clean = { path: database.path, identity };
    }
    // A reader-pinned WAL is healthy; only restart proof needs a completed checkpoint.
    retainRuntimeProof =
      !cache.failures.has(database.path) &&
      (alreadyClosed
        ? !priorCheckpointError
        : database.walMaintenance.health?.state === "blocked" &&
          isOpenClawAgentDatabasePathCurrent(database));
    if (database.db.isOpen) {
      database.db.close();
    }
  } catch (error) {
    if (lease) {
      clearOpenClawAgentIntegrityVerification(database.path, lease.env);
    }
    throw error;
  }
  if (lease) {
    releaseOpenClawAgentDatabaseLease(
      lease.leaseId,
      { env: lease.env, initializationAgentPaths: [database.path] },
      clean ?? (retainRuntimeProof ? "uncheckpointed" : undefined),
    );
    cache.leases.delete(database.path);
  }
  releaseAgentDeletionDatabaseCleanup(database);
  releaseAgentCreationClaimHandle(database);
  cache.idleTimers.get(database.db)?.[Symbol.dispose]();
  cache.idleTimers.delete(database.db);
}

/** A lifecycle scope closes its exact connection and retains its borrow until disposal succeeds. */
export function createAgentDatabaseScopeOwnedClose(
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

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeOpenClawAgentDatabaseByPath(
  pathname: string,
  expectedAgentId?: string,
): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  void revokeAgentDatabaseResources(
    { path: resolvedPath, agentId: expectedAgentId },
    logResourceCloseFailure,
  );
  // Revocation is immediate; the async owner retains its lease until native work joins.
  revokePendingAgentDatabaseOpen(resolvedPath, expectedAgentId);
  for (const retained of cache.retainedCloses) {
    if (
      retained.path === resolvedPath &&
      (expectedAgentId === undefined || retained.agentId === expectedAgentId)
    ) {
      retained.close();
    }
  }
  const database = cache.databases.get(resolvedPath);
  if (!database || (expectedAgentId !== undefined && database.agentId !== expectedAgentId)) {
    return false;
  }
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(resolvedPath);
  cache.failures.delete(resolvedPath);
  unregisterUnusedAgentDatabaseExitClose();
  return true;
}

type OpenClawAgentDatabaseWorkerCloseResult = {
  errors: Error[];
  settled: boolean;
};

/** Capture only the exact claim belonging to this admitted Worker connection. */
export function readOpenClawAgentDatabaseWorkerLeaseReceipt(
  pathname: string,
): OpenClawAgentDatabaseWorkerLeaseReceipt {
  const resolvedPath = path.resolve(pathname);
  const database = cache.databases.get(resolvedPath);
  const lease = cache.leases.get(resolvedPath);
  if (!database?.db.isOpen || !lease || cache.failures.has(resolvedPath)) {
    throw new Error(`Agent database Worker has no admitted lease: ${resolvedPath}`);
  }
  return readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim(lease.leaseId, {
    agentId: database.agentId,
    path: database.path,
    env: lease.env,
  });
}

/**
 * Converge a terminating worker's cached handle and durable lease without
 * turning an already committed worker result into an operation failure.
 * Callers own a bounded retry policy and must surface an unsettled result.
 */
export function settleOpenClawAgentDatabaseWorkerClose(
  pathname: string,
): OpenClawAgentDatabaseWorkerCloseResult {
  const resolvedPath = path.resolve(pathname);
  const errors: Error[] = [];
  const database = cache.databases.get(resolvedPath);
  if (database) {
    try {
      closeCachedOpenClawAgentDatabase(database);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (database.db.isOpen) {
      try {
        database.db.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!database.db.isOpen) {
      cache.idleTimers.get(database.db)?.[Symbol.dispose]();
      cache.idleTimers.delete(database.db);
      cache.databases.delete(resolvedPath);
      cache.failures.delete(resolvedPath);
      unregisterUnusedAgentDatabaseExitClose();
    }
  }

  if (!cache.databases.get(resolvedPath)?.db.isOpen) {
    const lease = cache.leases.get(resolvedPath);
    if (lease) {
      try {
        releaseOpenClawAgentDatabaseLease(lease.leaseId, {
          env: lease.env,
          initializationAgentPaths: [resolvedPath],
        });
        cache.leases.delete(resolvedPath);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    errors,
    settled: !cache.databases.get(resolvedPath)?.db.isOpen && !cache.leases.has(resolvedPath),
  };
}

/** Commit receipts invalidate every current handle of the captured physical database. */
export function invalidateOpenClawAgentWritableProjections(
  databaseIdentity: string,
  invalidate: (database: DatabaseSync) => void,
): void {
  for (const database of cache.databases.values()) {
    if (findOpenClawAgentDatabaseIdentity(database)?.identity === databaseIdentity) {
      invalidate(database.db);
    }
  }
}

export function closeOpenClawAgentDatabases(rootPath?: string): void {
  void revokeAgentDatabaseResources({ rootPath }, logResourceCloseFailure);
  for (const pathname of cache.pending.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      revokePendingAgentDatabaseOpen(pathname);
    }
  }
  for (const retained of cache.retainedCloses) {
    if (rootPath === undefined || isPathInside(rootPath, retained.path)) {
      retained.close();
    }
  }
  for (const pathname of cache.databases.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      closeOpenClawAgentDatabaseByPath(pathname);
    }
  }
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

/** Release fixture handles and pathname trust before a test root is recreated. */
export function closeOpenClawAgentDatabasesForTest(rootPath?: string): void {
  closeOpenClawAgentDatabases(rootPath);
  clearOpenClawAgentDatabaseValidationCache(rootPath);
  cache.terminal.clearAll(rootPath);
}

async function drainPendingAgentDatabaseOpens(
  selection: AgentDatabaseCloseSelection,
): Promise<void> {
  while (true) {
    const pending = [...cache.activePending].filter((owner) =>
      matchesAgentDatabaseClose(selection, owner),
    );
    if (pending.length === 0) {
      return;
    }
    for (const owner of pending) {
      revokePendingAgentDatabaseOpen(owner.path, selection.agentId);
    }
    await Promise.allSettled(pending.map((owner) => owner.promise));
  }
}

/** Drain native opens before a lifecycle owner releases shared state or removes its root. */
export async function closeOpenClawAgentDatabasesAsync(rootPath?: string): Promise<void> {
  const selection = { rootPath };
  await withAgentDatabaseCloseFence(selection, async (resourcePaths) => {
    const nativePaths = new Set(
      [...cache.databases.values(), ...cache.activePending, ...cache.retainedCloses]
        .filter((owner) => matchesAgentDatabaseClose(selection, owner))
        .map((owner) => owner.path),
    );
    const paths = new Set([...nativePaths, ...resourcePaths]);
    const results = await Promise.allSettled(
      [...paths].map((pathname) =>
        nativePaths.has(pathname)
          ? closeOpenClawAgentDatabaseByPathAsync(pathname)
          : drainAgentDatabaseResources({ ...selection, path: pathname }, async () => {}),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent database close failed");
    }
  });
}

/** Drain the exact retained owner before deletion, quarantine, or file replacement. */
export async function closeOpenClawAgentDatabaseByPathAsync(
  pathname: string,
  expectedAgentId?: string,
): Promise<boolean> {
  const selection = { path: path.resolve(pathname), agentId: expectedAgentId };
  revokePendingAgentDatabaseOpen(selection.path, expectedAgentId);
  return drainAgentDatabaseResources(selection, async () => {
    await drainPendingAgentDatabaseOpens(selection);
    const database = cache.databases.get(selection.path);
    if (database && (expectedAgentId === undefined || database.agentId === expectedAgentId)) {
      await database.walMaintenance.stop();
    }
    return closeOpenClawAgentDatabaseByPath(selection.path, expectedAgentId);
  });
}

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
  options?: { revalidateSchema: true },
): OpenClawAgentDatabaseOwnerInspection {
  let db: DatabaseSync | undefined;
  try {
    // Failed opens retain a disposal-only handle whose agentId is the request,
    // not a verified owner. Only admitted handles can answer from cache.
    const resolvedPath = path.resolve(pathname);
    const opened = cache.databases.get(resolvedPath);
    if (!options?.revalidateSchema && opened?.db.isOpen && !cache.failures.has(resolvedPath)) {
      runSqliteReadOperationSync(opened.db, () =>
        assertSupportedAgentSchemaVersion(opened.db, pathname),
      );
      refreshAgentDatabaseIdleTimer(opened);
      return { status: "owned", agentId: opened.agentId };
    }
    db = openSqliteReadOnlyDatabase(pathname, { readOnly: true });
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    if (options?.revalidateSchema) {
      invalidateSqliteSchemaFacts(db);
    }
    assertSupportedAgentSchemaVersion(db, pathname);
    const existing = readExistingAgentSchemaMeta(db);
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
    db?.close();
  }
}

export { cache as agentDatabaseLifecycle };
export { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
