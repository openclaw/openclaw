import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import {
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
} from "../infra/bun-sqlite-library.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { RetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { resolveStateReadWorkerCount } from "../infra/worker-pool-sizing.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { assertOpenClawAgentWriterReleased } from "./openclaw-agent-write-admission-state.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export type ReadPool = ReturnType<
  typeof createOwnedWorkerTaskPool<OpenClawStateReadRequest, OpenClawStateReadReply>
>;

export function stateReadPools(state: { pool?: ReadPool; awaitedPool?: ReadPool }): ReadPool[] {
  return [state.pool, state.awaitedPool].filter((pool) => pool !== undefined);
}

export function createStateReadPool(
  workerUrl: URL,
  nativeSource?: RetainedNativeWorkerSource,
): ReadPool {
  // Library selection precedes worker creation; each worker inherits its current close fact.
  ensureSqliteLibrarySelected();
  const pool = createOwnedWorkerTaskPool<OpenClawStateReadRequest, OpenClawStateReadReply>(
    {
      workerUrl,
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
      maxWorkers: resolveStateReadWorkerCount(),
      idleTimeoutMs: SQLITE_IDLE_HANDLE_TTL_MS,
      // Keep one reader warm; release surplus isolates after a short idle period.
      burstIdleTimeoutMs: 30_000,
      maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
      maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
    },
    nativeSource ? { retainedTransport: true, nativeSource } : undefined,
  );
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    const closeResources = pool.closeResources;
    const rotate = pool.rotate;
    pool.closeResources = (key) => {
      assertOpenClawAgentWriterReleased("close shared-state reader resources");
      return closeResources(key);
    };
    pool.rotate = () => {
      assertOpenClawAgentWriterReleased("rotate shared-state readers");
      return rotate();
    };
  }
  return pool;
}

export function closeReadResources(pool: ReadPool, key?: string) {
  return getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources
    ? pool.closeResources(key)
    : pool.rotate();
}

/** The same task/close contract; promise-only callers do not synchronously service it. */
export function startReadTask(
  selection: { pool: ReadPool; retained: boolean },
  input: Parameters<ReadPool["startTask"]>[0],
  options: Parameters<ReadPool["startTask"]>[1],
): ReturnType<ReadPool["startTask"]> {
  if (selection.retained) {
    return selection.pool.startTask(input, options);
  }
  const task = selection.pool.runTask(input, options);
  const result = createRetainedOperation<OpenClawStateReadReply>(() => {});
  void task.result.then(result.resolve, result.reject);
  return {
    ...result.operation,
    release(closeOptions) {
      const closed = createRetainedOperation<void>(() => {});
      void task.close(closeOptions).then(closed.resolve, closed.reject);
      return closed.operation;
    },
  };
}
