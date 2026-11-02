import { addAbortListener } from "node:events";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { isPathInside } from "../infra/path-guards.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { resolveAgentDatabaseIdleHandleTtlMs } from "../infra/sqlite-handle-lifecycle.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import {
  deferSqlitePostCommitPublication,
  hasSqlitePostCommitScope,
} from "../infra/sqlite-post-commit.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayShutdownCleanupSignal } from "../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { agentDatabaseBorrowers, retainAgentDatabase } from "./openclaw-agent-db-borrower.js";
import { createAgentDatabaseHandleCloser } from "./openclaw-agent-db-close.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  hasAgentDatabaseMaintenanceAuthority,
  readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { assertAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-maintenance-authority.js";
import {
  drainAgentDatabaseResources,
  hasOpenClawAgentDatabaseAsyncResources,
  matchesAgentDatabaseClose,
  registerAgentDatabaseResourceReleaseHandler,
  revokeAgentDatabaseResources,
  withAgentDatabaseCloseFence,
} from "./openclaw-agent-db-resources.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  invalidateOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  getOpenClawDatabaseMaintenanceResourceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";

const agentDbLog = createSubsystemLogger("state/agent-db");
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;
// Native and transformed SDK graphs must share the complete owner lifecycle;
// sharing only handles would split borrow pins, failure latches, and cleanup.
type AgentDatabaseLifecycle = typeof agentDatabaseBorrowers & {
  leases: Map<
    string,
    {
      leaseId: string;
      env: NodeJS.ProcessEnv;
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
  integrityRevoked?: boolean;
  workerPrepared?: boolean;
};
type RetainedAgentDatabaseClose = { agentId: string; path: string; close: () => void };
const cache = resolveGlobalSingleton<AgentDatabaseLifecycle>(
  Symbol.for("openclaw.agentDatabaseLifecycle"),
  () => ({
    ...agentDatabaseBorrowers,
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

// Install the activity owner before publishing handles, including reads with no timer yet.
agentDatabaseBorrowers.refreshIdleTimer = refreshAgentDatabaseIdleTimer;
registerAgentDatabaseResourceReleaseHandler((resource) => {
  if (!getGatewayShutdownCleanupSignal().aborted) {
    return;
  }
  // Resource owners settle their accepted work before waking deferred idle writers.
  for (const database of cache.databases.values()) {
    if (matchesAgentDatabaseClose({ path: database.path }, resource)) {
      cache.idleTimers.get(database.db)?.refresh();
    }
  }
});

export const closeCachedOpenClawAgentDatabase = createAgentDatabaseHandleCloser(cache);

export function registerAgentDatabaseHandle(
  database: OpenClawAgentDatabase,
  leaseId: string,
  env: NodeJS.ProcessEnv,
): void {
  cache.leases.set(database.path, { leaseId, env });
  cache.databases.set(database.path, database);
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
    // Maintenance closes its handles with schema custody; this detached timer has none.
    if (getOpenClawDatabaseMaintenanceResourceScope(database.db)) {
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
    // Their owners retire readers/workers; revoking here would cancel accepted native writes.
    if (cleanupSignal.aborted && hasOpenClawAgentDatabaseAsyncResources({ path: database.path })) {
      return;
    }
    try {
      // Registry discovery metadata survives eviction; only explicit disposal removes it.
      closeCachedOpenClawAgentDatabase(database);
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
      runInDetachedAsyncContext(() => queueMicrotask(closeIdle));
    } else {
      timer.refresh();
    }
  };
  const timer = runInDetachedAsyncContext(() =>
    setTimeout(closeIdle, resolveAgentDatabaseIdleHandleTtlMs()),
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
export async function settleOpenClawAgentDatabaseWorkerClose(
  pathname: string,
): Promise<OpenClawAgentDatabaseWorkerCloseResult> {
  const resolvedPath = path.resolve(pathname);
  const errors: Error[] = [];
  const database = cache.databases.get(resolvedPath);
  if (database) {
    try {
      // Join sidecar inspection before native close; a guarded close is not a failed owner.
      await database.walMaintenance.stop();
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

/** Latch integrity refusals so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(pathname: string, error: Error): void {
  // Quarantine revokes this process's trust because doctor may replace the file.
  invalidateOpenClawAgentDatabaseValidation(pathname);
  revokeSqliteDatabaseAdmissionsForPath(pathname);
  cache.terminal.record(pathname, error);
}

/** Release fixture handles and pathname trust before a test root is recreated. */
export function closeOpenClawAgentDatabasesForTest(rootPath?: string): void {
  closeOpenClawAgentDatabases(rootPath);
  clearOpenClawAgentDatabaseValidationCache(rootPath);
  cache.terminal.clearAll(rootPath);
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
    // The close selection already refuses new matching opens at their producer.
    const pending = [...cache.activePending].filter((owner) =>
      matchesAgentDatabaseClose(selection, owner),
    );
    for (const owner of pending) {
      revokePendingAgentDatabaseOpen(owner.path, expectedAgentId);
    }
    await Promise.allSettled(pending.map((owner) => owner.promise));
    const database = cache.databases.get(selection.path);
    if (database && (expectedAgentId === undefined || database.agentId === expectedAgentId)) {
      await database.walMaintenance.stop();
    }
    return closeOpenClawAgentDatabaseByPath(selection.path, expectedAgentId);
  });
}

export { cache as agentDatabaseLifecycle };
export { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
