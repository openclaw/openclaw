import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "../../infra/bun-sqlite-library.js";
import { getDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerDatabase,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import {
  resolveSessionHistoryWorkerCount,
  resolveWorkerPoolSize,
} from "../../infra/worker-pool-sizing.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
// V8's default young generation lets each idle reader keep ~60 MiB of nursery.
export const SESSION_TRANSCRIPT_WORKER_LIMITS = {
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 32,
};

export function createSessionTranscriptHistoryPool(
  maxWorkers: number | (() => number) = resolveWorkerPoolSize("singleton"),
  onRotationComplete?: () => void,
  options: { prewarmHistory?: true } = {},
) {
  let canCloseNativeResources: boolean | undefined;
  const createPool = () =>
    createOwnedWorkerTaskPool<
      SessionHistoryWorkerInput,
      SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>
    >(
      {
        workerUrl,
        workerOptions: { resourceLimits: SESSION_TRANSCRIPT_WORKER_LIMITS },
        maxWorkers: typeof maxWorkers === "number" ? maxWorkers : maxWorkers(),
        idleTimeoutMs: 0,
        burstIdleTimeoutMs: 30_000,
        onRotationComplete() {
          canCloseNativeResources = undefined;
          onRotationComplete?.();
        },
        prepareWorker: () => {
          ensureSqliteLibrarySelected();
          // Early workers stay conservative if native-close qualification was still pending.
          canCloseNativeResources =
            captureSqliteWorkerClosePolicy() && (canCloseNativeResources ?? true);
          return {
            options: {
              workerData: {
                databaseEngineSelection: getDatabaseEngineSelection(),
                ...options,
              },
            },
          };
        },
      },
      { databaseAccess: "read-only" },
    );
  // Boot installs the database engine after import, so a resolver sizes the pool on first use.
  type Pool = ReturnType<typeof createPool>;
  let pool: Pool | undefined;
  const owned = () => (pool ??= createPool());
  return {
    run: (...args: Parameters<Pool["run"]>) => owned().run(...args),
    rotate: () => owned().rotate(),
    runTask: (...args: Parameters<Pool["runTask"]>) => owned().runTask(...args),
    startTask: (...args: Parameters<Pool["startTask"]>) => owned().startTask(...args),
    closeResources: (key?: string) => owned().closeResources(key),
    startCloseResources: (key?: string) => owned().startCloseResources(key),
    startRotate: () => owned().startRotate(),
    getSnapshot: () => owned().getSnapshot(),
    close: (error?: Error) => owned().close(error),
    canCloseNativeResources: () => canCloseNativeResources === true,
  };
}

/** The foreground history lane sizes by the database engine that boot installs. */
export function createSessionHistoryLanePool(onRotationComplete: () => void) {
  return createSessionTranscriptHistoryPool(
    () => resolveSessionHistoryWorkerCount(getDatabaseEngineSelection()),
    onRotationComplete,
    { prewarmHistory: true },
  );
}

export function createUsageCostPool(
  kind: "read" | "refresh",
  onRotationComplete: () => void,
  onDatabasesClosed: (databases: readonly UsageCostWorkerDatabase[]) => void,
) {
  return new WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>({
    workerUrl,
    workerOptions: { resourceLimits: SESSION_TRANSCRIPT_WORKER_LIMITS },
    // Usage host writes and reader cleanup use one native worker per lane.
    workerClass: kind === "refresh" ? "writer" : "singleton",
    // Host writes can wait for a writer-held shared-compute reader; neither usage lane may hold its permit.
    idleTimeoutMs: 0,
    onRotationComplete,
    prepareWorker: () => {
      ensureSqliteLibrarySelected();
      return { options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } } };
    },
    validateResult(reply) {
      if (!reply.ok) {
        throw new UsageCostWorkerReplyError(reply.error);
      }
      onDatabasesClosed(reply.closedDatabases);
    },
  });
}

export type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  native: boolean;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  idleCleanupListener?: Disposable;
  rotation?: Promise<void>;
};

export type SessionCostWorkerLane = SessionDatabaseWorkerLane & {
  pool: WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>;
};

export type SessionHistoryWorkerLane = SessionDatabaseWorkerLane & {
  pool: ReturnType<typeof createSessionTranscriptHistoryPool>;
};
