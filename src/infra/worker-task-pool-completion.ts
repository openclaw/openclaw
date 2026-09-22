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
  artifactCleanup: Promise<unknown>,
): Promise<void> {
  return joinOwnedWorkerTasks([
    ...[...completion.preparationCleanups].map(([task, cleanup]) =>
      cleanup.finally(() => {
        if (completion.preparationCleanups.delete(task)) {
          completion.releaseAdmission(task);
        }
      }),
    ),
    artifactCleanup.then(() => undefined),
  ]);
}

function notifyExecutionSettled<Input, Output>(task: Task<Input, Output>): Error | undefined {
  try {
    if (!task.executionNotified) {
      task.executionNotified = true;
      task.options.onExecutionSettled?.({ retired: task.slot?.retired === true });
    }
  } catch (error) {
    return toErrorObject(error, "worker settlement receipt failed");
  }
  return undefined;
}

export function createWorkerTaskCompletion<Input, Output>(
  task: Task<Input, Output>,
  completion: WorkerTaskCompletion<Input, Output>,
  error?: Error,
  value?: Output,
): () => void {
  const preparation = task.owner ? undefined : task.preparation;
  let settlementError: Error | undefined;
  const complete = () => {
    if (!task.owner && !preparation) {
      completion.releaseAdmission(task);
    }
    return completeWorkerTask(task, completion, error, value, settlementError);
  };
  if (!preparation) {
    return complete;
  }
  const cleanup = createDeferredCore();
  completion.preparationCleanups.set(task, cleanup.promise);
  // A failed callback stays admission-bounded until close observes its outcome.
  void cleanup.promise.catch(() => undefined);
  return () => {
    // The native receipt precedes the result even while preparation retains input.
    settlementError = task.runInContext(() => notifyExecutionSettled(task));
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
  settlementError?: Error,
): Error | undefined {
  return task.runInContext(() => {
    let completionError = error ?? settlementError;
    const cleanupErrors: Error[] = settlementError ? [settlementError] : [];
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
      const cleanupError = toErrorObject(releaseError, "worker input release failed");
      cleanupErrors.push(cleanupError);
      completionError ??= cleanupError;
    }
    const receiptError = notifyExecutionSettled(task);
    if (receiptError) {
      cleanupErrors.push(receiptError);
      completionError ??= receiptError;
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
    const firstCleanupError = cleanupErrors[0];
    const cleanupError =
      cleanupErrors.length > 1
        ? new AggregateError(cleanupErrors, "Worker task cleanup failed", {
            cause: firstCleanupError,
          })
        : firstCleanupError;
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
