import { MessageChannel } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  withSqliteWorkerLifecycleCoordination,
  type SqliteMutationWorkerCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
  SessionTranscriptReconcileWorkerTask,
} from "./session-transcript-reconcile.worker.js";

type ReconcilePool = WorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>;
type ReconcileRuntime = {
  pool?: ReconcilePool;
  operations: Set<Promise<unknown>>;
  generation: number;
  stopped: boolean;
  closing?: Promise<void>;
};
const MAX_WORKERS = 1;
const runtime = resolveGlobalSingleton<ReconcileRuntime>(
  Symbol.for("openclaw.sessionTranscriptReconcilePool"),
  () => ({ operations: new Set(), generation: 0, stopped: false }),
  () => closeSessionTranscriptReconcileWorkerPool(),
);

export type SessionTranscriptReconcileOperation = {
  startTask: typeof startReconcileWorkerTask;
};

export function captureSessionTranscriptReconcileGeneration(): number {
  return runtime.generation;
}

export function isSessionTranscriptReconcileGenerationCurrent(generation: number): boolean {
  return !runtime.stopped && generation === runtime.generation;
}

/** Track the complete owner, including parent writes and independent lease recovery. */
export function runSessionTranscriptReconcileOperation<T>(
  generation: number,
  run: (operation: SessionTranscriptReconcileOperation) => Promise<T>,
): Promise<T> {
  if (!isSessionTranscriptReconcileGenerationCurrent(generation)) {
    return Promise.reject(new Error("Session transcript reconciliation lifecycle is closed"));
  }
  let active = true;
  const completion = createDeferredCore<T>();
  const promise = completion.promise.finally(() => {
    active = false;
    runtime.operations.delete(promise);
  });
  runtime.operations.add(promise);
  try {
    completion.resolve(
      run({
        startTask: (input) => {
          if (!active) {
            throw new Error("Session transcript reconciliation operation is closed");
          }
          return startReconcileWorkerTask(input);
        },
      }),
    );
  } catch (error) {
    completion.reject(error);
  }
  return promise;
}

/** Close admission first; accepted owners may still dispatch their lease-release tasks. */
export function closeSessionTranscriptReconcileWorkerPool(): Promise<void> {
  if (runtime.closing) {
    return runtime.closing;
  }
  runtime.stopped = true;
  runtime.generation++;
  runtime.closing = Promise.resolve()
    .then(async () => {
      while (runtime.operations.size) {
        await Promise.allSettled(runtime.operations);
      }
      await runtime.pool?.close();
      runtime.pool = undefined;
      // Calls captured during close must not enter the next lifecycle either.
      runtime.generation++;
      runtime.stopped = false;
    })
    .finally(() => {
      runtime.closing = undefined;
    });
  return runtime.closing;
}

export function getSessionTranscriptReconcileWorkerPoolSnapshot() {
  return (
    runtime.pool?.getSnapshot() ?? {
      maxWorkers: MAX_WORKERS,
      workers: 0,
      workersCreated: 0,
      activeTasks: 0,
      pendingTasks: 0,
    }
  );
}

function startReconcileWorkerTask(input: SessionTranscriptReconcileWorkerInput) {
  const owner =
    input.mode === "memory"
      ? undefined
      : {
          actorId: `transcript:${input.mode}:${input.leaseId}`,
          context: captureOpenClawStateWorkerContext({
            env: {
              OPENCLAW_STATE_DIR: input.stateDir,
              ...(input.externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
            },
          }),
        };
  const pool = (runtime.pool ??= new WorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReconcile),
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers: MAX_WORKERS,
    // Fleet work queues small locators; the pool's byte budget bounds admission.
    maxPendingTasks: Number.MAX_SAFE_INTEGER,
  }));
  const { port1: port, port2 } = new MessageChannel();
  const controller = new AbortController();
  const closed = new Promise<void>((resolve) => {
    port.once("close", resolve);
  });
  let released = false;
  let releaseFailed = false;
  let failure: Error | undefined;
  port.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
    if (message.type === "lease-released") {
      released = true;
    } else if (message.type === "lease-release-failed") {
      releaseFailed = true;
      failure = new Error(message.error);
    }
  });
  const inputBytes =
    128 +
    (owner
      ? 2 *
        (owner.actorId.length +
          owner.context.admission.databasePath.length +
          owner.context.environment.OPENCLAW_STATE_DIR.length +
          owner.context.coordinatorRuntime.directory.length)
      : 0) +
    (input.mode === "memory"
      ? input.sessionIds.reduce((bytes, id) => bytes + 2 * id.length, 0)
      : 2 * (input.stateDir.length + input.leaseId.length) +
        (input.mode === "disk" ? 2 * (input.path.length + input.agentId.length) : 0));
  let poolCompletion: Promise<void> | undefined;
  const execute = async (coordination?: SqliteMutationWorkerCoordination) => {
    poolCompletion = pool.run(
      { input, port: port2, coordination },
      {
        inputBytes,
        transferList: (task) => [
          task.port,
          ...(task.coordination?.stateLifecycle ? [task.coordination.stateLifecycle] : []),
        ],
        signal: controller.signal,
      },
    );
    try {
      await poolCompletion;
    } finally {
      port2.close();
      await closed;
    }
  };
  const completion = (
    !owner
      ? execute()
      : withSqliteWorkerLifecycleCoordination(owner.context, owner.actorId, execute, async () => {
          controller.abort();
          await poolCompletion?.catch(() => {});
          port2.close();
          await closed;
        })
  ).finally(() => port2.close());
  const leaseRelease = Promise.allSettled([completion, closed]).then(([result]) => {
    if (result.status === "rejected") {
      failure ??= toStringifiedError(result.reason);
    }
    if (!released) {
      failure ??= new Error("transcript worker task closed before lease release");
    }
    return { released, releaseFailed, failure };
  });
  return { port, controller, completion, closed, leaseRelease };
}
