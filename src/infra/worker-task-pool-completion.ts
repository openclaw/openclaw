import { channel as createDiagnosticsChannel } from "node:diagnostics_channel";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerComputePermit } from "./worker-task-capacity.js";
import { joinOwnedWorkerTasks } from "./worker-task-pool-owned.js";
import type { Task, WorkerTaskPoolDispatch } from "./worker-task-pool.types.js";

const taskDiagnostics = createDiagnosticsChannel("openclaw.worker.task");

export type WorkerTaskCompletion<Input, Output> = {
  preparationCleanups: Map<Task<Input, Output>, Promise<void>>;
  releaseAdmission(task: Task<Input, Output>): void;
  releaseCompute(permit: WorkerComputePermit): void;
  diagnostics(): ReturnType<WorkerTaskPoolDispatch["getSnapshot"]> & {
    worker: string | undefined;
    pendingBytes: number;
  };
};

export function joinWorkerTaskPreparationCleanups<Input, Output>(
  completion: WorkerTaskCompletion<Input, Output>,
  artifactCleanups: Iterable<Promise<void>>,
): Promise<void> {
  return joinOwnedWorkerTasks([
    ...[...completion.preparationCleanups].map(([task, cleanup]) =>
      cleanup.finally(() => {
        if (completion.preparationCleanups.delete(task)) {
          completion.releaseAdmission(task);
        }
      }),
    ),
    ...artifactCleanups,
  ]);
}

export function createWorkerTaskCompletion<Input, Output>(
  task: Task<Input, Output>,
  completion: WorkerTaskCompletion<Input, Output>,
  error?: Error,
  value?: Output,
): () => void {
  const preparation = task.owner ? undefined : task.preparation;
  const complete = () => {
    if (!task.owner && !preparation) {
      completion.releaseAdmission(task);
    }
    return completeWorkerTask(task, completion, error, value);
  };
  if (!preparation) {
    return complete;
  }
  const cleanup = createDeferredCore();
  completion.preparationCleanups.set(task, cleanup.promise);
  // A failed callback stays admission-bounded until close observes its outcome.
  void cleanup.promise.catch(() => undefined);
  return () => {
    // Retirement still owns failure precedence; preparation must not delay rejection.
    if (error) {
      task.reject(error);
    }
    void preparation.promise
      .then(() => {
        const failure = complete();
        if (failure) {
          throw failure;
        }
        completion.preparationCleanups.delete(task);
        completion.releaseAdmission(task);
        cleanup.resolve();
      })
      .catch(cleanup.reject);
  };
}

function completeWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  completion: WorkerTaskCompletion<Input, Output>,
  error?: Error,
  value?: Output,
): Error | undefined {
  return task.runInContext(() => {
    let completionError = error;
    let cleanupError: Error | undefined;
    try {
      // Retiring completion follows native exit. Queued inputs were never delivered.
      if (!task.inputConsumed) {
        task.inputConsumed = true;
        task.options.onInputConsumed?.();
      }
      const release = task.exchange?.onConsumed;
      task.exchange = undefined;
      release?.();
    } catch (releaseError) {
      cleanupError = toErrorObject(releaseError, "worker input release failed");
      completionError ??= cleanupError;
    }
    const permit = task.computePermit;
    task.computePermit = undefined;
    if (permit) {
      completion.releaseCompute(permit);
    }
    if (taskDiagnostics.hasSubscribers) {
      const now = performance.now();
      taskDiagnostics.publish({
        ...completion.diagnostics(),
        outcome: completionError ? "failed" : "ok",
        queueMs: (task.startedAt ?? now) - task.enqueuedAt,
        preparationMs: task.startedAt === undefined ? 0 : (task.preparedAt ?? now) - task.startedAt,
        runMs: task.preparedAt === undefined ? 0 : now - task.preparedAt,
        transferMs: task.transferMs,
      });
    }
    if (task.owner) {
      if (cleanupError) {
        throw cleanupError;
      }
    } else if (completionError) {
      task.reject(completionError);
    } else {
      // SAFETY: Only a validated successful worker reply supplies the completion value.
      task.resolve(value as Output);
    }
    return cleanupError;
  });
}
