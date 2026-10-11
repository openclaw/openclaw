import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveWorkerPoolSize } from "../../infra/worker-pool-sizing.js";
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
  const generations = new Set<{ canCloseNativeResources: boolean }>();
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
      // The worker inherits this same fact at creation; later admission cannot upgrade it.
      const current = { canCloseNativeResources: captureSqliteWorkerClosePolicy() };
      generations.add(current);
      return {
        options: {},
        async releaseResources() {
          generations.delete(current);
        },
      };
    },
    onRetirementFailure() {
      for (const generation of generations) {
        generation.canCloseNativeResources = false;
      }
    },
  });
  return {
    ...pool,
    canCloseNativeResources: () =>
      generations.size > 0 && [...generations].every((entry) => entry.canCloseNativeResources),
  };
}
