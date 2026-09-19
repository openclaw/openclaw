import { channel as createDiagnosticsChannel } from "node:diagnostics_channel";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { WorkerComputePermit } from "./worker-task-capacity.js";
import type { Task, WorkerTaskPoolDispatch } from "./worker-task-pool.types.js";

const taskDiagnostics = createDiagnosticsChannel("openclaw.worker.task");

export type WorkerTaskCompletion<Input, Output> = {
  releaseAdmission(task: Task<Input, Output>): void;
  releaseCompute(permit: WorkerComputePermit): void;
  diagnostics(): ReturnType<WorkerTaskPoolDispatch["getSnapshot"]> & {
    worker: string | undefined;
    pendingBytes: number;
  };
};

export function completeWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  completion: WorkerTaskCompletion<Input, Output>,
  error?: Error,
  value?: Output,
): void {
  task.runInContext(() => {
    // Owned tasks keep admission until explicit join observes their cleanup outcome.
    if (!task.preparing && !task.owner) {
      completion.releaseAdmission(task);
    }
    let completionError = error;
    const cleanupErrors: Error[] = [];
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
    try {
      if (!task.executionNotified) {
        task.executionNotified = true;
        task.options.onExecutionSettled?.({ retired: task.slot?.retired === true });
      }
    } catch (settlementError) {
      const cleanupError = toErrorObject(settlementError, "worker settlement receipt failed");
      cleanupErrors.push(cleanupError);
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
      const cleanupError = cleanupErrors[0];
      if (cleanupError) {
        throw cleanupErrors.length === 1
          ? cleanupError
          : new AggregateError(cleanupErrors, "Worker task cleanup failed", {
              cause: cleanupError,
            });
      }
    } else if (completionError) {
      task.reject(completionError);
    } else {
      // SAFETY: Only a validated successful worker reply supplies the completion value.
      task.resolve(value as Output);
    }
  });
}
