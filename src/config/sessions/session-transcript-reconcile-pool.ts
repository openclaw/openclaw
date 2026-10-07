import { addAbortListener } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
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
type ReconcileAdmission = {
  backlog: number;
  sequence: number;
  permit: Promise<() => void>;
  grant(): void;
  cancel(): void;
  detach(): void;
};
type ReconcileRuntime = {
  pool?: ReconcilePool;
  operations: Set<Promise<unknown>>;
  nextSequence: number;
  permits: number;
  waiters: ReconcileAdmission[];
  generation: number;
  stopped: boolean;
  closing?: Promise<void>;
};
const MAX_WORKERS = 1;
const runtime = resolveGlobalSingleton<ReconcileRuntime>(
  Symbol.for("openclaw.sessionTranscriptReconcilePool"),
  () => ({
    operations: new Set(),
    nextSequence: 0,
    permits: 0,
    waiters: [],
    generation: 0,
    stopped: false,
  }),
  () => closeSessionTranscriptReconcileWorkerPool(),
);

export type SessionTranscriptReconcileOperation = {
  signal: AbortSignal;
  shouldYield(remainingSessions: number): boolean;
  cancelReservation(): void;
  retainLeaseForCleanup(
    lease: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }>,
  ): void;
  startTask(
    ...args:
      | [
          input: Exclude<SessionTranscriptReconcileWorkerInput, { mode: "release" }>,
          backlog: number,
        ]
      | [input: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }>]
  ): ReturnType<typeof startReconcileWorkerTask>;
};

function sortReconcileAdmissions(): void {
  runtime.waiters.sort((a, b) => a.backlog - b.backlog || a.sequence - b.sequence);
}

function drainReconcileAdmissions(): void {
  while (runtime.permits < MAX_WORKERS && runtime.waiters.length) {
    runtime.waiters.shift()?.grant();
  }
}

function reserveReconcileAdmission(
  backlog: number,
  sequence: number,
  signal: AbortSignal,
): ReconcileAdmission {
  signal.throwIfAborted();
  const ready = createDeferredCore<() => void>();
  let releasePermit: (() => void) | undefined;
  const detach = () => signal.removeEventListener("abort", cancel);
  const cancel = () => {
    detach();
    const index = runtime.waiters.indexOf(admission);
    if (index >= 0) {
      runtime.waiters.splice(index, 1);
    }
    releasePermit?.();
    ready.reject(signal.reason ?? new Error("Session transcript reconcile reservation cancelled"));
  };
  const admission: ReconcileAdmission = {
    backlog,
    sequence,
    permit: ready.promise,
    grant() {
      runtime.permits++;
      let released = false;
      releasePermit = () => {
        if (released) {
          return;
        }
        released = true;
        runtime.permits--;
        drainReconcileAdmissions();
      };
      ready.resolve(releasePermit);
    },
    cancel,
    detach,
  };
  // A yielded reservation can be cancelled before the next pass awaits it.
  void ready.promise.catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  if (runtime.permits < MAX_WORKERS && runtime.waiters.length === 0) {
    admission.grant();
  } else {
    runtime.waiters.push(admission);
    sortReconcileAdmissions();
    drainReconcileAdmissions();
  }
  return admission;
}

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
  owner?: { agentId: string; path: string },
  signal?: AbortSignal,
): Promise<T> {
  if (!isSessionTranscriptReconcileGenerationCurrent(generation)) {
    return Promise.reject(new Error("Session transcript reconciliation lifecycle is closed"));
  }
  let active = true;
  const sequence = runtime.nextSequence++;
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
  }
  const abort = signal && addAbortListener(signal, () => controller.abort(signal.reason));
  let reservation: ReconcileAdmission | undefined;
  const cancelReservation = () => {
    reservation?.cancel();
    reservation = undefined;
  };
  let cleanupLease: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }> | undefined;
  let unregister: (() => void) | undefined;
  const completion = createDeferredCore<T>();
  const promise = completion.promise.finally(() => {
    abort?.[Symbol.dispose]();
    active = false;
    cancelReservation();
    runtime.operations.delete(promise);
    if (!cleanupLease) {
      unregister?.();
    }
  });
  runtime.operations.add(promise);
  try {
    unregister =
      owner &&
      registerOpenClawAgentDatabaseAsyncResource({
        ...owner,
        revoke: () => controller.abort(new Error("Session transcript reconciliation was revoked")),
        close() {
          // Failed projection work is advisory; an unsettled native lease retains custody.
          const closing = promise
            .catch(() => {})
            .then(async () => {
              if (cleanupLease) {
                await releaseReconcileWorkerLease(cleanupLease);
                cleanupLease = undefined;
                unregister?.();
              }
            });
          runtime.operations.add(closing);
          return closing.finally(() => runtime.operations.delete(closing));
        },
      });
    completion.resolve(
      run({
        signal: controller.signal,
        shouldYield: (remainingSessions) => {
          const head = runtime.waiters[0];
          if (!active || controller.signal.aborted || !head || head.backlog >= remainingSessions) {
            return false;
          }
          // Reserve before releasing this task's permit so equal backlogs keep their original order.
          reservation ??= reserveReconcileAdmission(remainingSessions, sequence, controller.signal);
          return true;
        },
        cancelReservation,
        retainLeaseForCleanup: (lease) => {
          cleanupLease ??= lease;
        },
        startTask: async (...args) => {
          if (!active) {
            throw new Error("Session transcript reconciliation operation is closed");
          }
          // Native exit may require a release task after the agent owner revokes new work.
          if (args.length === 1) {
            return startReconcileWorkerTask(args[0]);
          }
          const [input, backlog] = args;
          controller.signal.throwIfAborted();
          const admission = (reservation ??= reserveReconcileAdmission(
            backlog,
            sequence,
            controller.signal,
          ));
          admission.backlog = backlog;
          sortReconcileAdmissions();
          const release = await admission.permit;
          admission.detach();
          reservation = undefined;
          try {
            if (!active) {
              throw new Error("Session transcript reconciliation operation is closed");
            }
            controller.signal.throwIfAborted();
            const task = await startReconcileWorkerTask(input, controller.signal);
            void task.completion.then(release, release);
            return task;
          } catch (error) {
            release();
            throw error;
          }
        },
      }),
    );
  } catch (error) {
    completion.reject(error);
  }
  return promise;
}

export async function finishSessionTranscriptReconcileTask<T>({
  operation,
  task,
  input,
  handlingMessage,
  terminalReceived,
  outcome,
}: {
  operation: SessionTranscriptReconcileOperation;
  task: Awaited<ReturnType<typeof startReconcileWorkerTask>>;
  input: Exclude<SessionTranscriptReconcileWorkerInput, { mode: "release" }>;
  handlingMessage: Promise<void> | undefined;
  terminalReceived: boolean;
  outcome: Result<T, unknown>;
}): Promise<T> {
  const worker = task.port;
  let plannerFailure: Error | undefined;
  try {
    if (!terminalReceived) {
      task.controller.abort();
    }
    // A handler may initiate settlement. Join it here, outside that handler, before releasing
    // the independent lease; native exit and cleanup messages must not replace this task.
    await handlingMessage;
    if (input.mode === "disk" && terminalReceived) {
      worker.postMessage({ type: "release" }, []);
    }
    const plannerRelease = await task.leaseRelease;
    if (input.mode === "disk") {
      let cleanup = plannerRelease;
      if (!cleanup.released && !cleanup.releaseFailed) {
        const releaseTask = await operation.startTask({
          mode: "release",
          leaseId: input.leaseId,
          path: input.path,
          stateDir: input.stateDir,
          externallySupervised: input.externallySupervised,
        });
        try {
          cleanup = await releaseTask.leaseRelease;
        } finally {
          releaseTask.port.close();
          releaseTask.port.removeAllListeners();
        }
      }
      if (cleanup.failure) {
        throw cleanup.failure;
      }
      if (outcome.ok && plannerRelease.failure) {
        plannerFailure = plannerRelease.failure;
      }
    }
  } catch (error) {
    const failure = new Error(
      `Transcript lease cleanup incomplete; restart OpenClaw before deleting this agent: ${toStringifiedError(error).message}`,
      { cause: error },
    );
    if (input.mode === "disk") {
      operation.retainLeaseForCleanup({
        mode: "release",
        leaseId: input.leaseId,
        path: input.path,
        stateDir: input.stateDir,
        externallySupervised: input.externallySupervised,
      });
    }
    throw outcome.ok
      ? failure
      : new AggregateError([outcome.error, failure], failure.message, { cause: failure });
  } finally {
    worker.close();
    worker.removeAllListeners();
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (plannerFailure) {
    throw plannerFailure;
  }
  return outcome.value;
}

async function releaseReconcileWorkerLease(
  input: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }>,
): Promise<void> {
  const task = await startReconcileWorkerTask(input);
  try {
    const cleanup = await task.leaseRelease;
    if (cleanup.failure) {
      throw cleanup.failure;
    }
  } finally {
    task.port.close();
    task.port.removeAllListeners();
  }
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
  const snapshot = runtime.pool?.getSnapshot() ?? {
    maxWorkers: MAX_WORKERS,
    workers: 0,
    workersCreated: 0,
    activeTasks: 0,
    pendingTasks: 0,
  };
  return { ...snapshot, pendingTasks: snapshot.pendingTasks + runtime.waiters.length };
}

async function startReconcileWorkerTask(
  input: SessionTranscriptReconcileWorkerInput,
  signal?: AbortSignal,
) {
  const owner =
    input.mode === "memory"
      ? undefined
      : {
          actorId: `transcript:${input.mode}:${input.leaseId}`,
          context: captureOpenClawStateWorkerContext({
            initializationAgentPaths: [input.path],
            env: {
              OPENCLAW_STATE_DIR: input.stateDir,
              ...(input.externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
            },
          }),
        };
  const sourceIdentity =
    input.mode === "disk" ? readDatabasePathIdentitySync(input.path).key : undefined;
  if (owner && input.mode === "disk" && owner.context.admission.identity.key.startsWith("path:")) {
    // Finish canonical first creation before publishing a task that could claim an agent lease.
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(owner.context, async () => undefined, {
      assertCurrent: () => signal?.throwIfAborted(),
    });
  }
  signal?.throwIfAborted();
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
          owner.context.environment.OPENCLAW_STATE_DIR.length)
      : 0) +
    (input.mode === "release"
      ? 0
      : input.sessionIds.reduce((bytes, id) => bytes + 2 * id.length, 0)) +
    (input.mode === "memory"
      ? 0
      : 2 * (input.stateDir.length + input.leaseId.length + input.path.length) +
        (input.mode === "disk" ? 2 * input.agentId.length : 0));
  let poolCompletion: Promise<void> | undefined;
  const execute = async (coordination?: SqliteMutationWorkerCoordination) => {
    poolCompletion = pool.run(
      {
        input,
        port: port2,
        coordination,
        sourceIdentity,
      },
      {
        inputBytes,
        transferList: (task) => [
          task.port,
          ...(task.coordination?.reconciliation
            ? [task.coordination.reconciliation.admission]
            : []),
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
      : withSqliteWorkerLifecycleCoordination(
          owner.context,
          owner.actorId,
          execute,
          async () => {
            controller.abort();
            await poolCompletion?.catch(() => {});
            port2.close();
            await closed;
          },
          "reconciliation",
        )
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
