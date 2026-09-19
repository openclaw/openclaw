import { AsyncLocalStorage } from "node:async_hooks";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerDatabase,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionEntryListWorkerInput,
  SessionMembersWorkerInput,
  SessionRowPresenceWorkerInput,
  SessionTranscriptHistoryWorkerInput,
  SessionTranscriptWorkerReply,
  SessionUsageCacheWorkerInput,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
export const historyPages = new WorkerTaskPool<
  | SessionTranscriptHistoryWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionMembersWorkerInput
  | SessionEntryListWorkerInput
  | SessionUsageCacheWorkerInput,
  SessionTranscriptWorkerReply<
    | "history-page"
    | "session-row-presence"
    | "session-members"
    | "session-entry-list"
    | "usage-cache"
  >
>({
  workerUrl,
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
const runInHistoryOwnerContext = AsyncLocalStorage.snapshot();
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
  lane.idleTimer = runInHistoryOwnerContext(() =>
    historySetTimeout(() => {
      void rotateDatabaseWorkers(lane).catch((error: unknown) => {
        process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
      });
    }, 30 * 60_000),
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
