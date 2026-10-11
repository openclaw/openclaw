import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import {
  resolveWorkerPoolSize,
  SESSION_TRANSCRIPT_FOREGROUND_WORKERS,
} from "../../infra/worker-pool-sizing.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);

export function createSessionTranscriptReadPool<Input extends SessionTranscriptWorkerInput>(
  maxWorkers: number,
  sharedCompute = false,
) {
  return new WorkerTaskPool<Input, SessionTranscriptWorkerReply<Input["kind"]>>({
    workerUrl,
    prepareWorker: () => {
      // Bun loads one SQLite library per process; workers inherit the parent's selection.
      ensureSqliteLibrarySelected();
      return { options: {} };
    },
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers,
    sharedCompute,
  });
}

export function createSessionTranscriptHistoryPool(
  maxWorkers = resolveWorkerPoolSize("singleton"),
) {
  let canCloseNativeResources: boolean | undefined;
  const pool = createOwnedWorkerTaskPool<
    SessionHistoryWorkerInput,
    SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>
  >({
    workerUrl,
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers,
    idleTimeoutMs: 0,
    prepareWorker: () => {
      ensureSqliteLibrarySelected();
      // Early workers stay conservative if native-close qualification was still pending.
      canCloseNativeResources =
        captureSqliteWorkerClosePolicy() && (canCloseNativeResources ?? true);
      return { options: {} };
    },
  });
  return {
    ...pool,
    canCloseNativeResources: () => canCloseNativeResources === true,
    async rotate() {
      await pool.rotate();
      canCloseNativeResources = undefined;
    },
  };
}

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

export type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  nativeSequence: number;
  retiredSequence: number;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  rotation?: Promise<void>;
};

function createDatabaseWorkerLane<Pool extends SessionDatabaseWorkerLane["pool"]>(
  name: string,
  pool: Pool,
): SessionDatabaseWorkerLane & { pool: Pool } {
  return { name, pool, nativeSequence: 0, retiredSequence: 0, pending: 0 };
}

export function createSessionTranscriptWorkerLanes() {
  const historyLane = createDatabaseWorkerLane(
    "Session history",
    createSessionTranscriptHistoryPool(SESSION_TRANSCRIPT_FOREGROUND_WORKERS),
  );
  // Search retains its reader while the host checks writable index readiness.
  // It must never occupy the workers serving committed history and metadata.
  const transcriptSearchLane = createDatabaseWorkerLane(
    "Session transcript search",
    createSessionTranscriptHistoryPool(SESSION_TRANSCRIPT_FOREGROUND_WORKERS),
  );
  // Keep list materialization independent of large history pages, with one extra reader per store.
  const projectionLane = createDatabaseWorkerLane(
    "Session projection",
    createSessionTranscriptHistoryPool(),
  );
  // Full-store validation cannot yield its snapshot to a foreground history read.
  const maintenanceLane = createDatabaseWorkerLane(
    "Session maintenance",
    createSessionTranscriptHistoryPool(),
  );
  // Writers retain FIFO admission through target discovery and cleanup. These reads
  // cannot share a worker with history tasks that await a host-side database write.
  const targetDiscoveryLane = createDatabaseWorkerLane(
    "Session target discovery",
    createSessionTranscriptHistoryPool(),
  );
  const costReadLane = createDatabaseWorkerLane("Session usage read", createUsageCostPool("read"));
  const costRefreshLane = createDatabaseWorkerLane(
    "Session usage refresh",
    createUsageCostPool("refresh"),
  );

  return {
    historyLane,
    transcriptSearchLane,
    projectionLane,
    maintenanceLane,
    targetDiscoveryLane,
    costReadLane,
    costRefreshLane,
  };
}
