import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { joinOwnedWorkerTasks } from "@openclaw/worker-runtime";
import { encodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerDatabase,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { SESSION_TRANSCRIPT_FOREGROUND_WORKERS } from "../../infra/worker-pool-sizing.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { assertOpenClawAgentWriterReleased } from "../../state/openclaw-agent-write-admission-state.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  sessionHistoryCleanupError,
  decodeSessionTranscriptWorkerReadError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import {
  isSessionStoreReadCandidateCurrent,
  measureSessionStoreTargetInventoryInputBytes,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
  SessionStoreTargetInventoryResult,
} from "./session-store-target-inventory.js";
import { createSessionTranscriptHistoryPool } from "./session-transcript-read-pools.js";
import type { SessionHistoryWorkerInput } from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);

function createUsageCostPool(kind: "read" | "refresh") {
  return new WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>({
    workerUrl,
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    // A retired task releases lane-wide database custody, which requires one native worker.
    workerClass: kind === "refresh" ? "writer" : "singleton",
    // Host writes can wait for a writer-held shared-compute reader; neither usage lane may hold its permit.
    idleTimeoutMs: 0,
    prepareWorker: () => {
      ensureSqliteLibrarySelected();
      return { options: {} };
    },
    validateResult(reply) {
      if (!reply.ok) {
        throw new UsageCostWorkerReplyError(reply.error);
      }
    },
  });
}

type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  nativeSequence: number;
  retiredSequence: number;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  rotation?: Promise<void>;
};

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
};

export type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
  generation: number;
  pending: number;
  revoked: boolean;
  nativeSequences: Map<SessionDatabaseWorkerLane, number>;
  hostEffects: Set<Promise<unknown>>;
  cleanups: Set<SessionDatabaseCleanup>;
  aborters: Set<() => void>;
  closing?: Promise<void>;
  unregister: () => void;
  retainAlias: (alias: string) => void;
};

const historyDatabases = new Map<string, HistoryDatabaseResource>();
const historySetTimeout = setTimeout;
export const historyClearTimeout = clearTimeout;
let historyGeneration = 0;
function createDatabaseWorkerLane<Pool extends SessionDatabaseWorkerLane["pool"]>(
  name: string,
  pool: Pool,
): SessionDatabaseWorkerLane & { pool: Pool } {
  return { name, pool, nativeSequence: 0, retiredSequence: 0, pending: 0 };
}

export const historyLane = createDatabaseWorkerLane(
  "Session history",
  createSessionTranscriptHistoryPool(SESSION_TRANSCRIPT_FOREGROUND_WORKERS),
);
// Search retains its reader while the host checks writable index readiness.
// It must never occupy the workers serving committed history and metadata.
export const transcriptSearchLane = createDatabaseWorkerLane(
  "Session transcript search",
  createSessionTranscriptHistoryPool(SESSION_TRANSCRIPT_FOREGROUND_WORKERS),
);
// Keep list materialization independent of large history pages, with one extra reader per store.
export const projectionLane = createDatabaseWorkerLane(
  "Session projection",
  createSessionTranscriptHistoryPool(),
);
// Full-store validation cannot yield its snapshot to a foreground history read.
export const maintenanceLane = createDatabaseWorkerLane(
  "Session maintenance",
  createSessionTranscriptHistoryPool(),
);
// Writers retain FIFO admission through target discovery and cleanup. These reads
// cannot share a worker with history tasks that await a host-side database write.
export const targetDiscoveryLane = createDatabaseWorkerLane(
  "Session target discovery",
  createSessionTranscriptHistoryPool(),
);
export const costReadLane = createDatabaseWorkerLane(
  "Session usage read",
  createUsageCostPool("read"),
);
export const costRefreshLane = createDatabaseWorkerLane(
  "Session usage refresh",
  createUsageCostPool("refresh"),
);

const independentHistoryLanes = [
  historyLane,
  transcriptSearchLane,
  projectionLane,
  maintenanceLane,
];
const historyWorkerLanes = [...independentHistoryLanes, targetDiscoveryLane];
const databaseWorkerLanes = [...historyWorkerLanes, costReadLane, costRefreshLane];

// Install only in development: production dispatch/cleanup has no context check.
// Target discovery is reserved with the writer; its cold-read host callbacks
// reenter that reservation. Other pools can wait on an independent writer.
if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
  for (const lane of [...independentHistoryLanes, costReadLane, costRefreshLane]) {
    const rotate = lane.pool.rotate.bind(lane.pool);
    lane.pool.rotate = () => {
      assertOpenClawAgentWriterReleased(`drain the ${lane.name} reader pool`);
      return rotate();
    };
  }
  for (const lane of independentHistoryLanes) {
    const close = lane.pool.closeResources;
    lane.pool.closeResources = (key) => {
      assertOpenClawAgentWriterReleased(`close the ${lane.name} reader pool`);
      return close(key);
    };
  }
}
const memoryPressure = channel("openclaw.memory.critical");
let pressureSubscribed = false;

registerOpenClawStateDatabaseAsyncResource({
  phase: "after-resources",
  async close(identity) {
    if (identity) {
      return;
    }
    // Per-database closes retain execution; whole-runtime close owns its final retirement.
    await joinOwnedWorkerTasks(
      databaseWorkerLanes.map(async (lane) => {
        historyClearTimeout(lane.idleTimer);
        lane.idleTimer = undefined;
        await rotateDatabaseWorkers(lane);
      }),
    );
  },
});

function retireIdleDatabaseWorkers(): void {
  for (const lane of databaseWorkerLanes) {
    if (lane.pending > 0 || lane.rotation || lane.nativeSequence <= lane.retiredSequence) {
      continue;
    }
    historyClearTimeout(lane.idleTimer);
    void runInDetachedAsyncContext(() => rotateDatabaseWorkers(lane)).catch((error: unknown) => {
      process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
    });
  }
}

export function refreshDatabaseWorkerPressureSubscription(): void {
  const required = databaseWorkerLanes.some(
    (lane) =>
      lane.pending > 0 || lane.rotation !== undefined || lane.nativeSequence > lane.retiredSequence,
  );
  if (required === pressureSubscribed) {
    return;
  }
  pressureSubscribed = required;
  if (required) {
    memoryPressure.subscribe(retireIdleDatabaseWorkers);
  } else {
    memoryPressure.unsubscribe(retireIdleDatabaseWorkers);
  }
}

export function pruneHistoryDatabases(): void {
  for (const [key, resource] of historyDatabases) {
    if (
      resource.pending === 0 &&
      resource.nativeSequences.size === 0 &&
      resource.hostEffects.size === 0 &&
      resource.cleanups.size === 0 &&
      !resource.closing
    ) {
      resource.unregister();
      historyDatabases.delete(key);
    }
  }
}

export function releaseRetiredDatabaseCustody(
  lane: SessionDatabaseWorkerLane,
  through: number,
): void {
  lane.retiredSequence = Math.max(lane.retiredSequence, through);
  for (const resource of historyDatabases.values()) {
    const sequence = resource.nativeSequences.get(lane);
    if (sequence !== undefined && sequence <= through) {
      resource.nativeSequences.delete(lane);
    }
  }
  pruneHistoryDatabases();
  refreshDatabaseWorkerPressureSubscription();
}

export function rotateDatabaseWorkers(lane: SessionDatabaseWorkerLane): Promise<void> {
  const through = lane.nativeSequence;
  // rotate pauses dispatch synchronously; later factories receive a greater sequence.
  const rotation = lane.pool.rotate().then(() => releaseRetiredDatabaseCustody(lane, through));
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

// Missing reads can leave an idle worker without retaining any database custody.
export function armDatabaseWorkerIdleRetirement(lane: SessionDatabaseWorkerLane): void {
  historyClearTimeout(lane.idleTimer);
  refreshDatabaseWorkerPressureSubscription();
  if (lane.nativeSequence <= lane.retiredSequence || lane.pending > 0) {
    return;
  }
  lane.idleTimer = runInDetachedAsyncContext(() =>
    historySetTimeout(() => {
      void rotateDatabaseWorkers(lane).catch((error: unknown) => {
        process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
      });
    }, SQLITE_IDLE_HANDLE_TTL_MS),
  );
  lane.idleTimer.unref();
}

export function clearClosedDatabaseCustody(
  lane: SessionDatabaseWorkerLane,
  through: number,
  databases: readonly UsageCostWorkerDatabase[],
): void {
  for (const database of databases) {
    const resource = historyDatabases.get(JSON.stringify(database));
    const sequence = resource?.nativeSequences.get(lane);
    if (resource && sequence !== undefined && sequence <= through) {
      resource.nativeSequences.delete(lane);
    }
  }
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
  const through = lane.nativeSequence;
  try {
    await pool.closeResources(JSON.stringify([{ path: resource.database.path }]));
  } catch (error) {
    try {
      await rotateDatabaseWorkers(lane);
    } catch (retirementError) {
      throw sessionHistoryCleanupError(error, retirementError, "worker retirement");
    }
    throw error;
  }
  const sequence = resource.nativeSequences.get(lane);
  if (sequence !== undefined && sequence <= through) {
    resource.nativeSequences.delete(lane);
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
  if (!resource || resource.revoked) {
    const aliases = new Map<string, () => void>();
    const owned: HistoryDatabaseResource = {
      database,
      generation: ++historyGeneration,
      pending: 0,
      revoked: false,
      nativeSequences: new Map(),
      hostEffects: new Set(),
      cleanups: new Set(),
      aborters: new Set(),
      unregister: () => {},
      retainAlias(alias) {
        if (!aliases.has(alias)) {
          aliases.set(
            alias,
            runOutsideOpenClawDatabaseMaintenanceScope(() =>
              registerOpenClawAgentDatabaseAsyncResource({
                ...database,
                path: alias,
                revoke,
                close,
              }),
            ),
          );
        }
      },
    };
    const close = () => {
      if (!owned.closing) {
        const idle = owned.pending === 0;
        owned.closing = (async () => {
          await Promise.all(
            [...owned.nativeSequences.keys()].map((lane) =>
              closeDatabaseWorkerResource(owned, lane, idle),
            ),
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
      for (const release of aliases.values()) {
        release();
      }
      aliases.clear();
    };
    resource = owned;
    created = true;
  }
  try {
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
  }) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
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
  historyClearTimeout(lane.idleTimer);
  lane.pending++;
  refreshDatabaseWorkerPressureSubscription();
  try {
    let revoked = false;
    let closing: Promise<void> | undefined;
    let nativeCleanupPending = false;
    let candidateCleanupPending = false;
    let dispatched = false;
    let discoveryFailed = false;
    let outcome: { value: T } | { error: unknown };
    const assertCurrent = () => {
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
    const retire = (): Promise<void> => {
      closing ??= (async () => {
        nativeCleanupPending = true;
        try {
          await rotateDatabaseWorkers(lane);
          nativeCleanupPending = false;
        } finally {
          closing = undefined;
        }
      })();
      return closing;
    };
    const settleCandidates = async () => {
      // Failed discovery can retain handles outside candidate custody even on a proven worker.
      if (discoveryFailed || revoked || !lane.pool.canCloseNativeResources()) {
        await retire();
        return;
      }
      const through = lane.nativeSequence;
      candidateCleanupPending = true;
      try {
        const retained = new Map<string, HistoryDatabaseResource>();
        for (const resource of historyDatabases.values()) {
          if (resource.revoked || resource.closing || !resource.nativeSequences.has(lane)) {
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
            if (
              !isSessionStoreReadCandidateCurrent({
                path: alias,
                physicalPath: resource.database.path,
              })
            ) {
              throw new Error("Session discovery alias changed before reader custody transfer");
            }
            // The known owner must retain lexical close custody before discovery releases it.
            if (alias !== resource.database.path) {
              resource.retainAlias(alias);
            }
            retained.set(resource.database.path, resource);
          }
        }
        await lane.pool.closeResources(
          encodeAgentDatabaseReaderRequest({
            kind: "close",
            candidates: selected,
            retainedPaths: [...retained.keys()],
            deleted: false,
          }),
        );
        if (
          revoked ||
          [...retained.values()].some((resource) => resource.revoked || Boolean(resource.closing))
        ) {
          throw new WorkerTaskError(
            "Session reader custody was revoked during discovery cleanup",
            "unavailable",
          );
        }
        candidateCleanupPending = false;
        for (const resource of historyDatabases.values()) {
          const sequence = resource.nativeSequences.get(lane);
          if (
            sequence !== undefined &&
            sequence <= through &&
            !retained.has(resource.database.path) &&
            selected.some((candidate) =>
              matchesAgentDatabaseReadCandidatePath(candidate, resource.database.path),
            )
          ) {
            resource.nativeSequences.delete(lane);
          }
        }
        pruneHistoryDatabases();
      } catch (error) {
        try {
          await retire();
          candidateCleanupPending = false;
        } catch (retirementError) {
          throw sessionHistoryCleanupError(error, retirementError, "worker retirement");
        }
        throw error;
      }
    };
    const close = async () => {
      await retire();
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
      assertCurrent();
      const readStoreTargetResult = async (
        request: Omit<SessionStoreTargetReadRequest, "candidates">,
      ): Promise<Result<SessionStoreTargetReadResult, unknown>> => {
        const preparedRequest = {
          ...request,
          env: captureSessionTranscriptStorageEnvironment(request.env),
          candidates: capturedCandidates,
        };
        const reply = await lane.pool.run(
          () => {
            assertCurrent();
            dispatched = true;
            lane.nativeSequence++;
            return { kind: "session-store-target", request: preparedRequest };
          },
          { inputBytes: JSON.stringify(preparedRequest).length * 2, timeoutMs: 60_000 },
        );
        const result = unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply);
        if (
          typeof result === "boolean" ||
          Array.isArray(result) ||
          (result.kind !== "session-store-target" &&
            result.kind !== "session-target-registry-required")
        ) {
          throw new Error("Session history worker returned another result instead of store target");
        }
        assertCurrent();
        discoveryFailed ||= "readError" in result;
        return "readError" in result
          ? err(decodeSessionTranscriptWorkerReadError(result.readError))
          : ok(result);
      };
      const value = await operation({
        assertCurrent,
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
          const reply = await lane.pool.run(
            () => {
              assertCurrent();
              dispatched = true;
              lane.nativeSequence++;
              return { kind: "session-target-inventory", request: preparedRequest };
            },
            {
              inputBytes: measureSessionStoreTargetInventoryInputBytes(preparedRequest),
              timeoutMs: 60_000,
            },
          );
          const result =
            unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply);
          if (
            typeof result === "boolean" ||
            Array.isArray(result) ||
            (result.kind !== "session-target-inventory" &&
              result.kind !== "session-target-registry-required")
          ) {
            throw new Error(
              "Session history worker returned another result instead of target inventory",
            );
          }
          if (result.kind === "session-target-inventory") {
            // Best-effort inventory can encode a failed read instead of throwing it.
            discoveryFailed ||= result.agents.some(
              ({ result: inventory }) =>
                !inventory.available && inventory.reason !== "database-missing",
            );
          }
          if (result.kind === "session-target-registry-required") {
            // Release native readers before registry work without discarding a healthy worker.
            discoveryFailed ||= result.readFailed === true;
            await settleCandidates();
          }
          assertCurrent();
          return result;
        },
      });
      assertCurrent();
      outcome = { value };
    } catch (error) {
      outcome = { error };
    }
    // Discovery custody includes lexical aliases. Keep it until physical readers
    // settle; a later close through an alias must never miss a retained handle.
    if (dispatched) {
      try {
        if ("error" in outcome) {
          await retire();
        } else {
          await settleCandidates();
        }
      } catch (cleanupError) {
        outcome = {
          error:
            "error" in outcome
              ? sessionHistoryCleanupError(outcome.error, cleanupError, "worker retirement")
              : cleanupError,
        };
      }
    }
    if (!nativeCleanupPending && !candidateCleanupPending) {
      release();
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    assertCurrent();
    return outcome.value;
  } finally {
    lane.pending--;
    armDatabaseWorkerIdleRetirement(lane);
  }
}
