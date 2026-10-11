import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { joinOwnedWorkerTasks } from "@openclaw/worker-runtime";
import { encodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import type {
  UsageCostWorkerDatabase,
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { WorkerTaskError, type WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  decodeSessionTranscriptWorkerReadError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import {
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
  createSessionTranscriptWorkerLanes,
  type createSessionTranscriptHistoryPool,
  type SessionDatabaseWorkerLane,
} from "./session-transcript-read-pools.js";
import type { SessionHistoryWorkerInput } from "./session-transcript-worker.types.js";
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
};

export type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
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
export const {
  historyLane,
  transcriptSearchLane,
  projectionLane,
  maintenanceLane,
  targetDiscoveryLane,
  costReadLane,
  costRefreshLane,
} = createSessionTranscriptWorkerLanes();

const historyWorkerLanes = [
  historyLane,
  transcriptSearchLane,
  projectionLane,
  maintenanceLane,
  targetDiscoveryLane,
];
const databaseWorkerLanes = [...historyWorkerLanes, costReadLane, costRefreshLane];

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
  await pool.closeResources(JSON.stringify([{ path: resource.database.path }]));
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
  const admissionPaths = capturedCandidates
    .filter((candidate) => !candidate.scope)
    .map((candidate) => candidate.physicalPath);
  const admissionFamilies = capturedCandidates
    .filter((candidate) => candidate.scope === "sibling-family")
    .map((candidate) => path.dirname(candidate.physicalPath));
  historyClearTimeout(lane.idleTimer);
  lane.pending++;
  refreshDatabaseWorkerPressureSubscription();
  try {
    let revoked = false;
    let dispatched = false;
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
    const settleCandidates = async () => {
      if (!dispatched) {
        return;
      }
      dispatched = false;
      if (!lane.pool.canCloseNativeResources()) {
        await rotateDatabaseWorkers(lane);
        return;
      }
      const through = lane.nativeSequence;
      const retained = new Set<string>();
      for (const resource of historyDatabases.values()) {
        if (resource.revoked || !resource.nativeSequences.has(lane)) {
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
      // Discovery uses its captured paths; changing aliases mid-read is best effort.
      await lane.pool.closeResources(
        encodeAgentDatabaseReaderRequest({
          kind: "close",
          candidates: selected,
          retainedPaths: [...retained],
          deleted: false,
        }),
      );
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
      const runRead = async (
        input: Extract<
          SessionHistoryWorkerInput,
          { kind: "session-store-target" | "session-target-inventory" }
        >,
        inputBytes: number,
      ) => {
        const reply = await runWithSqliteDatabaseAdmissionTurn(
          admissionPaths,
          () =>
            lane.pool.run(
              () => {
                assertCurrent();
                dispatched = true;
                lane.nativeSequence++;
                return input;
              },
              { inputBytes, timeoutMs: 60_000 },
            ),
          admissionFamilies,
        );
        return unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply);
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
        if (
          typeof result === "boolean" ||
          Array.isArray(result) ||
          (result.kind !== "session-store-target" &&
            result.kind !== "session-target-registry-required")
        ) {
          throw new Error("Session history worker returned another result instead of store target");
        }
        return "readError" in result
          ? err(decodeSessionTranscriptWorkerReadError(result.readError))
          : ok(result);
      };
      return await operation({
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
          const result = await runRead(
            { kind: "session-target-inventory", request: preparedRequest },
            measureSessionStoreTargetInventoryInputBytes(preparedRequest),
          );
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
