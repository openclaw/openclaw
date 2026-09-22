import { channel } from "node:diagnostics_channel";
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
import {
  createOwnedWorkerTaskPool,
  WorkerTaskError,
  WorkerTaskPool,
} from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  sessionHistoryCleanupError,
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
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
export const historyPages = createOwnedWorkerTaskPool<
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>
>({
  workerUrl,
  workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
  maxWorkers: 1,
  idleTimeoutMs: 0,
  prepareWorker: () => {
    ensureSqliteLibrarySelected();
    return { options: {} };
  },
});

function createUsageCostPool(kind: "read" | "refresh") {
  return new WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>({
    workerUrl,
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers: 1,
    // Foreground reads must remain available while refresh awaits a host writer.
    sharedCompute: kind === "refresh",
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

export type SessionDatabaseCleanup = { run: () => Promise<void> };

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
};

const historyDatabases = new Map<string, HistoryDatabaseResource>();
const historySetTimeout = setTimeout;
export const historyClearTimeout = clearTimeout;
let historyGeneration = 0;
export const historyLane: SessionDatabaseWorkerLane = {
  name: "Session history",
  pool: historyPages,
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};
export const costReadLane: SessionCostWorkerLane = {
  name: "Session usage read",
  pool: createUsageCostPool("read"),
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};
export const costRefreshLane: SessionCostWorkerLane = {
  name: "Session usage refresh",
  pool: createUsageCostPool("refresh"),
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};

channel("openclaw.memory.critical").subscribe(() => {
  for (const lane of [historyLane, costReadLane, costRefreshLane]) {
    if (lane.pending > 0 || lane.rotation || lane.nativeSequence <= lane.retiredSequence) {
      continue;
    }
    historyClearTimeout(lane.idleTimer);
    void runInDetachedAsyncContext(() => rotateDatabaseWorkers(lane)).catch((error: unknown) => {
      process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
    });
  }
});

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
}

export function rotateDatabaseWorkers(lane: SessionDatabaseWorkerLane): Promise<void> {
  const through = lane.nativeSequence;
  // rotate pauses dispatch synchronously; later factories receive a greater sequence.
  const rotation = lane.pool.rotate().then(() => releaseRetiredDatabaseCustody(lane, through));
  lane.rotation = rotation;
  const finished = () => {
    if (lane.rotation === rotation) {
      lane.rotation = undefined;
    }
  };
  void rotation.then(finished, finished);
  return rotation;
}

// Missing reads can leave an idle worker without retaining any database custody.
export function armDatabaseWorkerIdleRetirement(lane: SessionDatabaseWorkerLane): void {
  historyClearTimeout(lane.idleTimer);
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

export function acquireHistoryDatabaseResource(
  options: OpenClawAgentDatabaseOptions,
): HistoryDatabaseResource {
  const database = {
    agentId: normalizeAgentId(options.agentId),
    path: resolveOpenClawAgentSqlitePath(options),
  };
  const key = JSON.stringify(database);
  let resource = historyDatabases.get(key);
  if (!resource || resource.revoked) {
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
    };
    const close = () => {
      if (!owned.closing) {
        owned.closing = (async () => {
          await Promise.all([...owned.nativeSequences.keys()].map(rotateDatabaseWorkers));
          await Promise.allSettled(owned.hostEffects);
          for (const cleanup of owned.cleanups) {
            await cleanup.run();
          }
        })().finally(() => {
          owned.closing = undefined;
          pruneHistoryDatabases();
          armDatabaseWorkerIdleRetirement(historyLane);
          armDatabaseWorkerIdleRetirement(costReadLane);
          armDatabaseWorkerIdleRetirement(costRefreshLane);
        });
        void owned.closing.catch(() => {});
      }
      return owned.closing;
    };
    owned.unregister = registerOpenClawAgentDatabaseAsyncResource({
      ...database,
      revoke: () => {
        owned.revoked = true;
        for (const abort of owned.aborters) {
          abort();
        }
        void close();
      },
      close,
    });
    historyDatabases.set(key, owned);
    resource = owned;
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
    readTargetInventory: (
      request: Omit<SessionStoreTargetInventoryRequest, "candidates">,
    ) => Promise<SessionStoreTargetInventoryResult>;
  }) => Promise<T>,
): Promise<T> {
  const capturedCandidates = candidates.map(({ path, physicalPath, scope }) => ({
    path,
    physicalPath,
    scope,
  }));
  const selected = capturedCandidates.map(({ physicalPath, scope }) => ({
    path: physicalPath,
    ...(scope ? { scope } : {}),
  }));
  historyClearTimeout(historyLane.idleTimer);
  historyLane.pending++;
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
      for (const unregister of releases.toReversed()) {
        unregister();
      }
    };
    const retire = (): Promise<void> => {
      closing ??= (async () => {
        nativeCleanupPending = true;
        try {
          await rotateDatabaseWorkers(historyLane);
          nativeCleanupPending = false;
        } finally {
          closing = undefined;
        }
      })();
      return closing;
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
      const value = await operation({
        assertCurrent,
        readStoreTarget: async (request) => {
          const preparedRequest = { ...request, candidates: capturedCandidates };
          const reply = await historyPages.run(
            () => {
              assertCurrent();
              dispatched = true;
              historyLane.nativeSequence++;
              return { kind: "session-store-target", request: preparedRequest };
            },
            { inputBytes: JSON.stringify(preparedRequest).length * 2, timeoutMs: 60_000 },
          );
          const result =
            unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply);
          if (
            typeof result === "boolean" ||
            Array.isArray(result) ||
            (result.kind !== "session-store-target" &&
              result.kind !== "session-target-registry-required")
          ) {
            throw new Error(
              "Session history worker returned another result instead of store target",
            );
          }
          assertCurrent();
          return result;
        },
        readTargetInventory: async (request) => {
          const preparedRequest = { ...request, candidates: capturedCandidates };
          const reply = await historyPages.run(
            () => {
              assertCurrent();
              dispatched = true;
              historyLane.nativeSequence++;
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
            // Native discovery may already have opened other candidates. Settle
            // their worker before continuing through the registry's read owner.
            await retire();
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
        // Bun retains native statements after close; failed reads may leave unowned handles.
        if ("error" in outcome || discoveryFailed || process.versions.bun) {
          await retire();
        } else {
          const through = historyLane.nativeSequence;
          candidateCleanupPending = true;
          try {
            await historyPages.closeResources(JSON.stringify(selected));
            candidateCleanupPending = false;
            for (const resource of historyDatabases.values()) {
              const sequence = resource.nativeSequences.get(historyLane);
              if (
                sequence !== undefined &&
                sequence <= through &&
                selected.some((candidate) =>
                  matchesAgentDatabaseReadCandidatePath(candidate, resource.database.path),
                )
              ) {
                resource.nativeSequences.delete(historyLane);
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
    historyLane.pending--;
    armDatabaseWorkerIdleRetirement(historyLane);
  }
}
