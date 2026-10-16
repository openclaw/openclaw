import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "../../infra/bun-sqlite-library.js";
import { getDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import {
  resolveWorkerPoolSize,
  SESSION_TRANSCRIPT_FOREGROUND_WORKERS,
} from "../../infra/worker-pool-sizing.js";
import {
  createOwnedWorkerTaskPool,
  WorkerTaskError,
  WorkerTaskPool,
} from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../state/openclaw-agent-db-resources.js";
import { observeOpenClawDatabaseMaintenanceResource } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);

type RetainedStore = {
  revoked: boolean;
  releases: (() => void)[];
  close(this: void): Promise<void>;
};

export function createSessionTranscriptReadPool<Input extends SessionTranscriptWorkerInput>(
  maxWorkers: number,
  sharedCompute = false,
) {
  const pool = new WorkerTaskPool<Input, SessionTranscriptWorkerReply<Input["kind"]>>({
    workerUrl,
    prepareWorker: () => {
      // Bun loads one SQLite library per process; workers inherit the parent's selection.
      ensureSqliteLibrarySelected();
      return { options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } } };
    },
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers,
    sharedCompute,
  });
  const stores = new Map<string, RetainedStore>();
  function retainStore(storePath: string) {
    let retained = stores.get(storePath);
    if (!retained) {
      const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
      const candidate = captureSessionStoreReadCandidate(
        target.path,
        target.agentId || target.shared ? undefined : "sibling-family",
      );
      const owned: RetainedStore = {
        revoked: false,
        releases: [],
        async close(this: void) {
          // Replies leave cached native readers alive; join worker exit before deleting a store.
          await pool.rotate();
          for (const release of owned.releases) {
            release();
          }
          if (stores.get(storePath) === owned) {
            stores.delete(storePath);
          }
        },
      };
      try {
        for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
          owned.releases.push(
            registerOpenClawAgentDatabaseReadCandidateResource({
              path: pathname,
              scope: candidate.scope,
              revoke: () => {
                owned.revoked = true;
              },
              close: owned.close,
            }),
          );
        }
      } catch (error) {
        for (const release of owned.releases) {
          release();
        }
        throw error;
      }
      stores.set(storePath, owned);
      retained = owned;
    }
    for (const release of retained.releases) {
      observeOpenClawDatabaseMaintenanceResource(release);
    }
    return retained;
  }
  registerOpenClawStateDatabaseAsyncResource({
    phase: "after-resources",
    async close(identity) {
      if (identity) {
        return;
      }
      const closing = [...stores.values()];
      for (const store of closing) {
        store.revoked = true;
      }
      await Promise.all(closing.map((store) => store.close()));
    },
  });
  return {
    async run(
      input: Input,
      options: WorkerTaskOptions<Input>,
      databases: {
        storePaths: readonly string[];
        admissionPaths: readonly string[];
        families?: readonly string[];
      },
    ) {
      // Register before admission yields; cleanup also owns reads waiting to dispatch.
      const retained = databases.storePaths.map(retainStore);
      return runWithSqliteDatabaseAdmissionTurn(
        databases.admissionPaths,
        () =>
          pool.run(() => {
            if (retained.some((store) => store.revoked)) {
              throw new WorkerTaskError(
                "Session transcript database read was revoked",
                "unavailable",
              );
            }
            return input;
          }, options),
        databases.families,
      );
    },
  };
}

export function createSessionTranscriptHistoryPool(
  maxWorkers = resolveWorkerPoolSize("singleton"),
) {
  let canCloseNativeResources: boolean | undefined;
  const pool = createOwnedWorkerTaskPool<
    SessionHistoryWorkerInput,
    SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>
  >(
    {
      workerUrl,
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
      maxWorkers,
      idleTimeoutMs: 0,
      burstIdleTimeoutMs: 30_000,
      prepareWorker: () => {
        ensureSqliteLibrarySelected();
        // Early workers stay conservative if native-close qualification was still pending.
        canCloseNativeResources =
          captureSqliteWorkerClosePolicy() && (canCloseNativeResources ?? true);
        return {
          options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } },
        };
      },
    },
    { databaseAccess: "read-only" },
  );
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
      return { options: { workerData: { databaseEngineSelection: getDatabaseEngineSelection() } } };
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
