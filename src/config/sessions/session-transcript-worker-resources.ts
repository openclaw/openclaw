import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { joinOwnedWorkerTasks } from "@openclaw/worker-runtime";
import { racePromiseWithAbortSignal } from "../../../packages/retry/src/index.js";
import { encodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import type {
  UsageCostWorkerDatabase,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { SESSION_TRANSCRIPT_FOREGROUND_WORKERS } from "../../infra/worker-pool-sizing.js";
import { WorkerTaskError, type WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  assertAgentDatabaseResourceAdmission,
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { getPendingOpenClawAgentDatabasePreparation } from "../../state/openclaw-agent-execution.js";
import {
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { createStateWorkerMemoryPressureSubscription } from "../../state/openclaw-state-worker-memory-pressure.js";
import type {
  CombinedSessionStoreTopologyRequest,
  CombinedSessionStoreTopologyResult,
} from "./combined-store.types.js";
import {
  decodeSessionTranscriptWorkerReadError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  captureSessionStoreReadCandidate,
  measureSessionStoreTargetInventoryInputBytes,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
  SessionStoreTargetInventoryResult,
} from "./session-store-target-inventory.js";
import {
  createSessionTranscriptHistoryPool,
  createUsageCostPool,
  type SessionDatabaseWorkerLane,
} from "./session-transcript-read-pools.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type SessionCostWorkerLane = SessionDatabaseWorkerLane & {
  pool: WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>;
};

export type SessionHistoryWorkerLane = SessionDatabaseWorkerLane & {
  pool: ReturnType<typeof createSessionTranscriptHistoryPool>;
};

export type SessionDatabaseCleanup = { run: () => Promise<void> };

/** Physical path for work; callers' lexical paths select the same owner for cleanup. */
export type SessionHistoryDatabaseTarget = OpenClawAgentDatabaseOptions & {
  requestedPaths?: readonly string[];
  /** Capture a cold physical source after admission and before the row request. */
  prepareRead?: () => void;
};

export type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
  pending: number;
  revoked: boolean;
  nativeLanes: Set<SessionDatabaseWorkerLane>;
  hostEffects: Set<Promise<unknown>>;
  cleanups: Set<SessionDatabaseCleanup>;
  aborters: Set<() => void>;
  closing?: Promise<void>;
  unregister: () => void;
  observeMaintenance: () => void;
  retainAlias: (alias: string) => void;
  retainCandidate: (candidate: SessionStoreReadCandidate) => void;
  matchesPath: (pathname: string) => boolean;
  retire: () => Promise<void>;
};

const historyDatabases = new Map<string, HistoryDatabaseResource>();
// An exact lexical lookup derives from the physical owner; it owns no separate lifecycle.
const historyReadCandidates = new Map<string, HistoryDatabaseResource>();
const historySetTimeout = setTimeout;
const historyClearTimeout = clearTimeout;
const databaseWorkerLanes: SessionDatabaseWorkerLane[] = [];

export function registerSessionTranscriptReaderLane<Pool extends SessionDatabaseWorkerLane["pool"]>(
  name: string,
  createPool: (onRotationComplete: () => void) => Pool,
): SessionDatabaseWorkerLane & { pool: Pool } {
  const lane: SessionDatabaseWorkerLane & { pool: Pool } = {
    name,
    pool: createPool(() => releaseRetiredDatabaseCustody(lane)),
    native: false,
    pending: 0,
  };
  databaseWorkerLanes.push(lane);
  return lane;
}

function createHistoryLane(name: string, maxWorkers?: number) {
  return registerSessionTranscriptReaderLane(name, (closed) =>
    createSessionTranscriptHistoryPool(maxWorkers, closed),
  );
}

export const historyLane = createHistoryLane(
  "Session history",
  SESSION_TRANSCRIPT_FOREGROUND_WORKERS,
);
// Search readiness can await a host writer; it cannot occupy committed-history workers.
export const transcriptSearchLane = createHistoryLane(
  "Session transcript search",
  SESSION_TRANSCRIPT_FOREGROUND_WORKERS,
);
// List materialization and full-store snapshots keep independent readers.
export const projectionLane = createHistoryLane("Session projection");
export const maintenanceLane = createHistoryLane("Session maintenance");
// Cold discovery retains writer FIFO without waiting behind history's host writes.
export const targetDiscoveryLane = createHistoryLane("Session target discovery");
function createCostLane(name: string, kind: "read" | "refresh"): SessionCostWorkerLane {
  const lane: SessionCostWorkerLane = registerSessionTranscriptReaderLane(name, (closed) =>
    createUsageCostPool(kind, closed, (databases) => clearClosedDatabaseCustody(lane, databases)),
  );
  return lane;
}

export const costReadLane = createCostLane("Session usage read", "read");
export const costRefreshLane = createCostLane("Session usage refresh", "refresh");
const historyWorkerLanes = [
  historyLane,
  transcriptSearchLane,
  projectionLane,
  maintenanceLane,
  targetDiscoveryLane,
];

export const refreshDatabaseWorkerPressureSubscription =
  createStateWorkerMemoryPressureSubscription(
    () =>
      databaseWorkerLanes.some(
        (lane) => lane.pending > 0 || lane.rotation !== undefined || lane.native,
      ),
    retireIdleDatabaseWorkers,
  );

registerOpenClawStateDatabaseAsyncResource({
  phase: "after-resources",
  async close(identity) {
    if (identity) {
      return;
    }
    // Per-database closes retain execution; whole-runtime close owns its final retirement.
    await joinOwnedWorkerTasks(
      databaseWorkerLanes.map(async (lane) => {
        clearDatabaseWorkerIdleRetirement(lane);
        await rotateDatabaseWorkers(lane);
      }),
    );
  },
});

function retireIdleDatabaseWorkers(): void {
  for (const lane of databaseWorkerLanes) {
    if (lane.pending > 0 || lane.rotation || !lane.native) {
      continue;
    }
    clearDatabaseWorkerIdleRetirement(lane);
    void runInDetachedAsyncContext(() => rotateDatabaseWorkers(lane)).catch((error: unknown) => {
      process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
    });
  }
}

export function pruneHistoryDatabases(): void {
  for (const [key, resource] of historyDatabases) {
    if (
      resource.pending === 0 &&
      resource.nativeLanes.size === 0 &&
      resource.hostEffects.size === 0 &&
      resource.cleanups.size === 0 &&
      !resource.closing
    ) {
      resource.unregister();
      historyDatabases.delete(key);
    }
  }
}

export function releaseRetiredDatabaseCustody(lane: SessionDatabaseWorkerLane): void {
  clearDatabaseWorkerIdleRetirement(lane);
  lane.native = false;
  for (const resource of historyDatabases.values()) {
    resource.nativeLanes.delete(lane);
  }
  pruneHistoryDatabases();
  refreshDatabaseWorkerPressureSubscription();
}

export function rotateDatabaseWorkers(lane: SessionDatabaseWorkerLane): Promise<void> {
  const rotation = lane.pool.rotate();
  lane.rotation = rotation;
  refreshDatabaseWorkerPressureSubscription();
  const finished = () => {
    if (lane.rotation === rotation) {
      lane.rotation = undefined;
      refreshDatabaseWorkerPressureSubscription();
    }
  };
  void rotation.then(finished, finished);
  return rotation;
}

export function clearDatabaseWorkerIdleRetirement(lane: SessionDatabaseWorkerLane): void {
  historyClearTimeout(lane.idleTimer);
  lane.idleTimer = undefined;
}

// Only new work cancels the idle deadline; database cleanup must not keep
// unrelated isolates warm beyond their own five-minute retention window.
export function armDatabaseWorkerIdleRetirement(lane: SessionDatabaseWorkerLane): void {
  refreshDatabaseWorkerPressureSubscription();
  if (!lane.native || lane.pending > 0) {
    clearDatabaseWorkerIdleRetirement(lane);
    return;
  }
  if (lane.idleTimer) {
    return;
  }
  lane.idleTimer = runInDetachedAsyncContext(() =>
    historySetTimeout(() => {
      lane.idleTimer = undefined;
      void rotateDatabaseWorkers(lane).catch((error: unknown) => {
        process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
      });
    }, 5 * 60_000),
  );
  lane.idleTimer.unref();
}

async function closeDatabaseWorkerResource(
  resource: HistoryDatabaseResource,
  lane: SessionDatabaseWorkerLane,
  idle: boolean,
): Promise<void> {
  const pool = historyWorkerLanes.find((candidate) => candidate === lane)?.pool;
  // Active or unqualified readers keep native-exit custody. Proven idle readers
  // release the exact database while retaining this worker's loaded code.
  if (!idle || !pool?.canCloseNativeResources()) {
    await rotateDatabaseWorkers(lane);
    return;
  }
  // Clear this fact before yielding: a later dispatch publishes its own native reader.
  resource.nativeLanes.delete(lane);
  try {
    await pool.closeResources(JSON.stringify([{ path: resource.database.path }]));
  } catch (error) {
    resource.nativeLanes.add(lane);
    throw error;
  }
}

/** Usage replies are accepted before the singleton lane can dispatch its successor. */
function clearClosedDatabaseCustody(
  lane: SessionCostWorkerLane,
  databases: readonly UsageCostWorkerDatabase[],
): void {
  for (const database of databases) {
    historyDatabases.get(JSON.stringify(database))?.nativeLanes.delete(lane);
  }
}

/** One worker's eviction requests pool-wide cleanup before releasing database custody. */
export async function settleSessionHistoryWorkerEviction(
  lane: SessionHistoryWorkerLane,
  database: SessionHistoryDatabaseTarget,
): Promise<void> {
  const resource = historyDatabases.get(JSON.stringify(database));
  if (resource) {
    // Preparing tasks can own input before a worker exists to receive a native close.
    await closeDatabaseWorkerResource(resource, lane, lane.pool.getSnapshot().activeTasks === 0);
  }
}

/** Finish admitted usage cleanup while deletion still permits its retained writers to settle. */
export async function retireSessionHistoryWorkerDatabases(options: {
  agentId: string;
  paths: readonly string[];
}): Promise<void> {
  const agentId = normalizeAgentId(options.agentId);
  const paths = [...new Set(options.paths.map((pathname) => path.resolve(pathname)))];
  const selected = [...historyDatabases.values()].filter(
    (resource) =>
      resource.database.agentId === agentId &&
      paths.some((pathname) => resource.matchesPath(pathname)),
  );
  const results = await Promise.allSettled(selected.map((resource) => resource.retire()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Session database work is still draining");
  }
}

export function acquireHistoryDatabaseResource(
  options: SessionHistoryDatabaseTarget,
): HistoryDatabaseResource {
  const database = {
    agentId: normalizeAgentId(options.agentId),
    path: resolveOpenClawAgentSqlitePath(options),
  };
  const key = JSON.stringify(database);
  let resource = historyDatabases.get(key);
  let created = false;
  if (resource?.revoked) {
    // Failed retirement keeps cleanup custody until the existing close/prune owner settles it.
    assertAgentDatabaseResourceAdmission(resource.database);
    throw new WorkerTaskError("Session database work is still draining", "unavailable");
  }
  if (!resource) {
    const aliases = new Map<
      string,
      { candidate: SessionStoreReadCandidate; unregister: () => void }
    >();
    const owned: HistoryDatabaseResource = {
      database,
      pending: 0,
      revoked: false,
      nativeLanes: new Set(),
      hostEffects: new Set(),
      cleanups: new Set(),
      aborters: new Set(),
      unregister: () => {},
      observeMaintenance: () => observeOpenClawDatabaseMaintenanceResource(unregister),
      matchesPath: (pathname) =>
        pathname === database.path ||
        [...aliases.values()].some(({ candidate }) =>
          matchesAgentDatabaseReadCandidatePath(candidate, pathname),
        ),
      retire() {
        revoke();
        return close();
      },
      retainAlias(alias) {
        const aliasKey = JSON.stringify([alias]);
        if (!aliases.has(aliasKey)) {
          aliases.set(aliasKey, {
            candidate: { path: alias, physicalPath: alias },
            unregister: runOutsideOpenClawDatabaseMaintenanceScope(() =>
              registerOpenClawAgentDatabaseAsyncResource({
                ...database,
                path: alias,
                revoke,
                close,
              }),
            ),
          });
        }
      },
      retainCandidate(candidate) {
        // The physical registration owns maintenance; aliases only select its cleanup.
        for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
          const aliasKey = JSON.stringify([pathname, candidate.scope]);
          if (!aliases.has(aliasKey)) {
            aliases.set(aliasKey, {
              candidate: { ...candidate, path: pathname },
              unregister: runOutsideOpenClawDatabaseMaintenanceScope(() =>
                registerOpenClawAgentDatabaseReadCandidateResource({
                  path: pathname,
                  scope: candidate.scope,
                  revoke,
                  close,
                }),
              ),
            });
          }
        }
      },
    };
    const close = () => {
      if (!owned.closing) {
        const idle = owned.pending === 0;
        owned.closing = (async () => {
          await Promise.all(
            [...owned.nativeLanes].map((lane) => closeDatabaseWorkerResource(owned, lane, idle)),
          );
          await Promise.allSettled(owned.hostEffects);
          for (const cleanup of owned.cleanups) {
            await cleanup.run();
          }
          if (owned.revoked) {
            owned.unregister();
          }
        })().finally(() => {
          owned.closing = undefined;
          pruneHistoryDatabases();
          for (const lane of databaseWorkerLanes) {
            armDatabaseWorkerIdleRetirement(lane);
          }
        });
        void owned.closing.catch(() => {});
      }
      return owned.closing;
    };
    const revoke = () => {
      owned.revoked = true;
      for (const abort of owned.aborters) {
        abort();
      }
      void close();
    };
    let unregister: (() => void) | undefined = registerOpenClawAgentDatabaseAsyncResource({
      ...database,
      revoke,
      close,
    });
    // A revoked close and a later prune can both retire this owner; release custody once.
    owned.unregister = () => {
      unregister?.();
      unregister = undefined;
      for (const [pathname, retained] of historyReadCandidates) {
        if (retained === owned) {
          historyReadCandidates.delete(pathname);
        }
      }
      for (const alias of aliases.values()) {
        alias.unregister();
      }
      aliases.clear();
    };
    resource = owned;
    created = true;
  }
  try {
    resource.observeMaintenance();
    for (const requestedPath of options.requestedPaths ?? []) {
      const alias = resolveOpenClawAgentSqlitePath({ ...options, path: requestedPath });
      if (alias !== database.path) {
        resource.retainAlias(alias);
      }
    }
  } catch (error) {
    if (created) {
      resource.unregister();
    }
    throw error;
  }
  if (created) {
    historyDatabases.set(key, resource);
  }
  return resource;
}

export function acquireSessionTranscriptReadResource(storePath: string): HistoryDatabaseResource {
  const retained = historyReadCandidates.get(storePath);
  if (retained) {
    if (retained.revoked) {
      assertAgentDatabaseResourceAdmission(retained.database);
      throw new WorkerTaskError("Session database work is still draining", "unavailable");
    }
    retained.observeMaintenance();
    return retained;
  }
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const candidate = captureSessionStoreReadCandidate(
    target.path,
    target.agentId || target.shared ? undefined : "sibling-family",
  );
  const resource = acquireHistoryDatabaseResource({
    agentId: target.agentId || "main",
    path: candidate.physicalPath,
  });
  resource.retainCandidate(candidate);
  historyReadCandidates.set(storePath, resource);
  return resource;
}

/** Keep captured discovery aliases until the existing history worker retires its readers. */
export async function withSessionHistoryWorkerReadCandidates<T>(
  candidates: readonly SessionStoreReadCandidate[],
  operation: (scope: {
    assertCurrent: () => void;
    readStoreTarget: (
      request: Omit<SessionStoreTargetReadRequest, "candidates">,
    ) => Promise<SessionStoreTargetReadResult>;
    readStoreTargetResult: (
      request: Omit<SessionStoreTargetReadRequest, "candidates">,
    ) => Promise<Result<SessionStoreTargetReadResult, unknown>>;
    readTargetInventory: (
      request: Omit<SessionStoreTargetInventoryRequest, "candidates">,
    ) => Promise<SessionStoreTargetInventoryResult>;
    readCombinedTopology: (
      request: Omit<CombinedSessionStoreTopologyRequest, "candidates">,
    ) => Promise<CombinedSessionStoreTopologyResult>;
  }) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
  signal?: AbortSignal,
): Promise<T> {
  const capturedCandidates = candidates.map(({ path: requestedPath, physicalPath, scope }) => ({
    path: requestedPath,
    physicalPath,
    scope,
  }));
  const selected = capturedCandidates.map(({ physicalPath, scope }) => ({
    path: physicalPath,
    ...(scope ? { scope } : {}),
  }));
  const admissionPaths = capturedCandidates
    .filter((candidate) => !candidate.scope)
    .map((candidate) => candidate.physicalPath);
  const admissionFamilies = capturedCandidates
    .filter((candidate) => candidate.scope === "sibling-family")
    .map((candidate) => path.dirname(candidate.physicalPath));
  clearDatabaseWorkerIdleRetirement(lane);
  lane.pending++;
  refreshDatabaseWorkerPressureSubscription();
  try {
    let revoked = false;
    let dispatched = false;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (revoked) {
        throw new WorkerTaskError("Session target discovery was revoked", "unavailable");
      }
    };
    const releases: Array<() => void> = [];
    const release = () => {
      for (const unregister of releases.splice(0).toReversed()) {
        unregister();
      }
    };
    const settleCandidates = async () => {
      if (!dispatched) {
        return;
      }
      dispatched = false;
      if (!lane.pool.canCloseNativeResources()) {
        await rotateDatabaseWorkers(lane);
        return;
      }
      const retained = new Set<string>();
      for (const resource of historyDatabases.values()) {
        if (resource.revoked || !resource.nativeLanes.has(lane)) {
          continue;
        }
        for (const candidate of capturedCandidates) {
          if (
            !matchesAgentDatabaseReadCandidatePath(
              { ...candidate, path: candidate.physicalPath },
              resource.database.path,
            )
          ) {
            continue;
          }
          const alias = candidate.scope
            ? path.join(path.dirname(candidate.path), path.basename(resource.database.path))
            : candidate.path;
          if (alias !== resource.database.path) {
            resource.retainAlias(alias);
          }
          retained.add(resource.database.path);
        }
      }
      const closing: HistoryDatabaseResource[] = [];
      for (const resource of historyDatabases.values()) {
        if (
          resource.nativeLanes.has(lane) &&
          !retained.has(resource.database.path) &&
          selected.some((candidate) =>
            matchesAgentDatabaseReadCandidatePath(candidate, resource.database.path),
          )
        ) {
          resource.nativeLanes.delete(lane);
          closing.push(resource);
        }
      }
      // Discovery uses its captured paths; changing aliases mid-read is best effort.
      try {
        await lane.pool.closeResources(
          encodeAgentDatabaseReaderRequest({
            kind: "close",
            candidates: selected,
            retainedPaths: [...retained],
            deleted: false,
          }),
        );
      } catch (error) {
        for (const resource of closing) {
          resource.nativeLanes.add(lane);
        }
        throw error;
      }
      pruneHistoryDatabases();
    };
    const close = async () => {
      await rotateDatabaseWorkers(lane);
      release();
    };
    const retained = new Set<string>();
    try {
      for (const candidate of capturedCandidates) {
        for (const pathname of [candidate.path, candidate.physicalPath]) {
          const key = JSON.stringify([pathname, candidate.scope]);
          if (retained.has(key)) {
            continue;
          }
          retained.add(key);
          releases.push(
            registerOpenClawAgentDatabaseReadCandidateResource({
              path: pathname,
              scope: candidate.scope,
              revoke: () => {
                revoked = true;
              },
              close,
            }),
          );
        }
      }
      const runRead = async <
        Input extends Extract<
          SessionHistoryWorkerInput,
          { kind: "session-store-target" | "session-target-inventory" | "combined-store-topology" }
        >,
      >(
        input: Input,
        inputBytes: number,
      ): Promise<SessionTranscriptWorkerValues[Input["kind"]]> => {
        // An admitted empty catalog can still belong to the agent's first schema birth.
        for (const physicalPath of admissionPaths) {
          const preparation = getPendingOpenClawAgentDatabasePreparation(physicalPath);
          if (preparation) {
            await racePromiseWithAbortSignal(preparation, signal, (aborted) => aborted.reason);
          }
        }
        const reply = await runWithSqliteDatabaseAdmissionTurn(
          admissionPaths,
          () =>
            lane.pool.run(
              () => {
                assertCurrent();
                dispatched = true;
                lane.native = true;
                return input;
              },
              { inputBytes, timeoutMs: 60_000, signal },
            ),
          admissionFamilies,
          signal,
        );
        const result = unwrapSessionTranscriptWorkerReply(reply);
        // SAFETY: The pool pairs this reply with the exact request dispatched above.
        return result as SessionTranscriptWorkerValues[Input["kind"]];
      };
      const readStoreTargetResult = async (
        request: Omit<SessionStoreTargetReadRequest, "candidates">,
      ): Promise<Result<SessionStoreTargetReadResult, unknown>> => {
        const preparedRequest = {
          ...request,
          env: captureSessionTranscriptStorageEnvironment(request.env),
          candidates: capturedCandidates,
        };
        const result = await runRead(
          { kind: "session-store-target", request: preparedRequest },
          JSON.stringify(preparedRequest).length * 2,
        );
        return "readError" in result
          ? err(decodeSessionTranscriptWorkerReadError(result.readError))
          : ok(result);
      };
      return await operation({
        assertCurrent,
        readCombinedTopology: async (request) => {
          const preparedRequest = {
            ...request,
            options: {
              ...request.options,
              discovery: {
                ...request.options.discovery,
                env: captureSessionTranscriptStorageEnvironment(request.options.discovery.env),
              },
            },
            candidates: capturedCandidates,
          };
          return await runRead(
            { kind: "combined-store-topology", request: preparedRequest },
            JSON.stringify(preparedRequest).length * 2,
          );
        },
        readStoreTargetResult,
        readStoreTarget: async (request) => {
          const read = await readStoreTargetResult(request);
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        },
        readTargetInventory: async (request) => {
          const preparedRequest = {
            ...request,
            env: captureSessionTranscriptStorageEnvironment(request.env),
            candidates: capturedCandidates,
          };
          const result = await runRead(
            { kind: "session-target-inventory", request: preparedRequest },
            measureSessionStoreTargetInventoryInputBytes(preparedRequest),
          );
          if (result.kind === "session-target-registry-required") {
            // Release native readers before registry work without discarding a healthy worker.
            await settleCandidates();
          }
          return result;
        },
      });
    } finally {
      try {
        await settleCandidates();
      } finally {
        release();
      }
    }
  } finally {
    lane.pending--;
    armDatabaseWorkerIdleRetirement(lane);
  }
}
