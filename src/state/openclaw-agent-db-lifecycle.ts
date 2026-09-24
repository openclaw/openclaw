import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { releaseAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import {
  readOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "./openclaw-agent-db-identity.js";
import {
  readOpenClawAgentDatabaseWorkerLeaseReceiptFromClaim,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import {
  drainAgentDatabaseResources,
  matchesAgentDatabaseClose,
  revokeAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
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
  idleTimers: WeakMap<DatabaseSync, NodeJS.Timeout>;
  incognito: WeakSet<OpenClawAgentDatabase>;
  generation: number;
  failures: Map<string, unknown>;
  leases: Map<string, { leaseId: string; env: NodeJS.ProcessEnv }>;
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
};
type RetainedAgentDatabaseClose = { agentId: string; path: string; close: () => void };
const cache = resolveGlobalSingleton<AgentDatabaseLifecycle>(
  Symbol.for("openclaw.agentDatabaseLifecycle"),
  () => ({
    databases: new Map(),
    borrowers: new WeakMap(),
    idleTimers: new WeakMap(),
    incognito: new WeakSet(),
    generation: 0,
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

/** Runtime reads and opens share the generation-aware process-local damage latch. */
export function assertAgentDatabaseTerminalOpenAllowed(pathname: string): void {
  const failure = cache.terminal.get(pathname);
  if (failure) {
    throw failure;
  }
}

function logResourceCloseFailure(pathname: string, error: unknown): void {
  agentDbLog.warn("Agent database resource close failed", { path: pathname, error });
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

/** Activity and final borrower release start the same idle window. */
export function refreshAgentDatabaseIdleTimer(database: OpenClawAgentDatabase): void {
  // Incognito's connection is its only durable owner; idle close would erase it.
  if (cache.incognito.has(database)) {
    return;
  }
  const existing = cache.idleTimers.get(database.db);
  if (existing) {
    existing.refresh();
    return;
  }
  const timer = runInSqliteMaintenanceContext(() =>
    setTimeout(() => {
      if (cache.databases.get(database.path) !== database) {
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
        if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
          cache.unregisterExitClose?.();
          cache.unregisterExitClose = null;
        }
      } catch (error) {
        // Keep native/lease custody on the original entry until cleanup succeeds.
        logResourceCloseFailure(database.path, error);
        timer.refresh();
      }
    }, SQLITE_IDLE_HANDLE_TTL_MS),
  );
  timer.unref();
  cache.idleTimers.set(database.db, timer);
}

/** Dispose only this publication; a later admission at the same path is independent. */
export function closeMaintenanceAgentDatabase(database: OpenClawAgentDatabase): void {
  if (cache.databases.get(database.path) !== database) {
    return;
  }
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(database.path);
  cache.failures.delete(database.path);
  if (cache.incognito.has(database)) {
    cache.generation += 1;
  }
}

export function closeCachedOpenClawAgentDatabase(
  database: OpenClawAgentDatabase,
  options: { eviction?: boolean } = {},
): void {
  // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
  // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
  const lease = cache.leases.get(database.path);
  let clean: { path: string; identity: string } | undefined;
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
      if (typeof identity === "string") {
        clean = { path: database.path, identity };
      }
    }
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
    releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env }, clean);
    cache.leases.delete(database.path);
  }
  releaseAgentDeletionDatabaseCleanup(database);
  clearTimeout(cache.idleTimers.get(database.db));
  cache.idleTimers.delete(database.db);
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
  const incognito = cache.incognito.has(database);
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(resolvedPath);
  cache.failures.delete(resolvedPath);
  if (incognito) {
    cache.generation += 1;
  }
  if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
    cache.unregisterExitClose?.();
    cache.unregisterExitClose = null;
  }
  return true;
}

export type OpenClawAgentDatabaseWorkerCloseResult = {
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
      clearTimeout(cache.idleTimers.get(database.db));
      cache.idleTimers.delete(database.db);
      const incognito = cache.incognito.has(database);
      cache.databases.delete(resolvedPath);
      cache.failures.delete(resolvedPath);
      if (incognito) {
        cache.generation += 1;
      }
      if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
        cache.unregisterExitClose?.();
        cache.unregisterExitClose = null;
      }
    }
  }

  if (!cache.databases.get(resolvedPath)?.db.isOpen) {
    const lease = cache.leases.get(resolvedPath);
    if (lease) {
      try {
        releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
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

/** Close cached agent handles, optionally restricted to one runtime root. */
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

/** Drain native opens before a lifecycle owner releases shared state or removes its root. */
export async function closeOpenClawAgentDatabasesAsync(rootPath?: string): Promise<void> {
  // Retained resources may drain slowly; revoke native admission before yielding to them.
  for (const owner of cache.activePending) {
    if (rootPath === undefined || isPathInside(rootPath, owner.path)) {
      revokePendingAgentDatabaseOpen(owner.path);
    }
  }
  await drainAgentDatabaseResources({ rootPath }, async () => {
    while (true) {
      const pending = [...cache.activePending].filter(
        (owner) => rootPath === undefined || isPathInside(rootPath, owner.path),
      );
      if (pending.length === 0) {
        break;
      }
      for (const owner of pending) {
        revokePendingAgentDatabaseOpen(owner.path);
      }
      await Promise.allSettled(pending.map((owner) => owner.promise));
    }
    closeOpenClawAgentDatabases(rootPath);
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
    while (true) {
      const pending = [...cache.activePending].filter((owner) =>
        matchesAgentDatabaseClose(selection, owner),
      );
      if (pending.length === 0) {
        break;
      }
      for (const owner of pending) {
        revokePendingAgentDatabaseOpen(owner.path, expectedAgentId);
      }
      await Promise.allSettled(pending.map((owner) => owner.promise));
    }
    return closeOpenClawAgentDatabaseByPath(selection.path, expectedAgentId);
  });
}

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
): OpenClawAgentDatabaseOwnerInspection {
  let db: DatabaseSync | undefined;
  try {
    // Failed opens retain a disposal-only handle whose agentId is the request,
    // not a verified owner. Only admitted handles can answer from cache.
    const resolvedPath = path.resolve(pathname);
    const opened = cache.databases.get(resolvedPath);
    if (opened?.db.isOpen && !cache.failures.has(resolvedPath)) {
      assertSupportedAgentSchemaVersion(opened.db, pathname);
      refreshAgentDatabaseIdleTimer(opened);
      return { status: "owned", agentId: opened.agentId };
    }
    db = openNodeSqliteDatabase(pathname, { readOnly: true });
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
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

/** Lists process-held incognito databases without opening new sentinel handles. */
export function listOpenIncognitoAgentDatabases(): Array<{ agentId: string; storePath: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen && cache.incognito.has(database))
    .map((database) => ({ agentId: database.agentId, storePath: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.storePath.localeCompare(right.storePath),
    );
}

/** Borrow committed process-held facts without opening or querying a private store. */
export function getOpenIncognitoAgentDatabase(agentId: string, pathname: string) {
  const database = cache.databases.get(path.resolve(pathname));
  return database?.db.isOpen &&
    database.agentId === normalizeAgentId(agentId) &&
    cache.incognito.has(database)
    ? database
    : undefined;
}

/** Return the generation of process-held incognito database membership. */
export function readOpenIncognitoAgentDatabaseGeneration(): number {
  return cache.generation;
}

/** Returns whether this exact process-held database is incognito/in-memory. */
export function isIncognitoOpenClawAgentDatabase(database: OpenClawAgentDatabase): boolean {
  return cache.incognito.has(database);
}

export { cache as agentDatabaseLifecycle };
export { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
