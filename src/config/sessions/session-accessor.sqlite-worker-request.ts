import { AsyncLocalStorage } from "node:async_hooks";
import type { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import type { SqliteSessionReclamationAdmissionDiagnostics } from "./session-accessor.sqlite-contract.js";

export type SqliteWorkerWriteAdmission<Result> = (
  run: (refusal?: { error: unknown }) => Promise<Result | undefined>,
  diagnostics: SqliteSessionReclamationAdmissionDiagnostics,
) => Promise<void>;

export type SqliteMutationWorkerMessage<Result> =
  | { type: "commit-request"; operationId: number }
  | { type: "admission-request" | "admission-release"; operationId: number; admissionId: number }
  | { type: "reclaimed"; operationId: number; result: Result };

/** Share request authority, not connection lifetime: cold mutations join exit; sweeps join each result. */
export function runSqliteMutationWorkerRequest<Result>(params: {
  worker: Worker;
  operationId: number;
  completion: "result" | "exit";
  onCommitRequest: () => void;
  withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
  dispatch?: () => void;
  getFailure?: () => Error | undefined;
  onExit?: (code: number) => void;
}): Promise<Result> {
  const { worker, operationId } = params;
  return new Promise((resolve, reject) => {
    let result: Result | undefined;
    let workerError: Error | undefined;
    let transportError: Error | undefined;
    let admission:
      | {
          id: number;
          released: Deferred;
          diagnostics: SqliteSessionReclamationAdmissionDiagnostics;
        }
      | undefined;
    let admissionId = 0;
    let completed = false;
    const admissionTasks: Promise<void>[] = [];
    const fail = (error: unknown) => {
      workerError ??= toStringifiedError(error);
      void worker.terminate();
    };
    const error = (failure: unknown) => {
      // Parent authority failures take precedence over the Worker's generic unwind error.
      transportError ??= toStringifiedError(failure);
    };
    const messageError = (failure: unknown) => {
      error(failure);
      void worker.terminate();
    };
    const finish = (code?: number) => {
      if (completed) {
        return;
      }
      completed = true;
      if (admission) {
        admission.diagnostics.releaseCause = code === undefined ? "worker-release" : "worker-exit";
        admission.released.resolve();
      }
      worker.off("message", receive);
      worker.off("exit", exit);
      worker.off("error", error);
      worker.off("messageerror", messageError);
      void Promise.all(admissionTasks).then(() => {
        const failure = workerError ?? transportError ?? params.getFailure?.();
        if (failure) {
          reject(failure);
        } else if (code !== undefined && code !== 0) {
          reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
        } else if (result === undefined) {
          reject(new Error("SQLite session reclamation Worker exited without results"));
        } else {
          resolve(result);
        }
      }, reject);
    };
    const exit = (code: number) => {
      params.onExit?.(code);
      finish(code);
    };
    // Worker events inherit its first caller; each request must retain its own authority context.
    const receive = AsyncLocalStorage.bind((message: SqliteMutationWorkerMessage<Result>) => {
      if (message.operationId !== operationId) {
        return;
      }
      if (message.type === "commit-request") {
        try {
          params.onCommitRequest();
        } catch (failure) {
          // The rejected shared gate makes the Worker roll back and unwind.
          workerError ??= toStringifiedError(failure);
        }
      } else if (message.type === "admission-request") {
        if (admission || message.admissionId !== admissionId + 1) {
          fail(
            new Error(
              "SQLite reclamation Worker requested invalid write admission; cleanup is uncertain, restart OpenClaw before deleting the owning agent",
            ),
          );
          return;
        }
        const requested = {
          id: ++admissionId,
          released: createDeferredCore(),
          diagnostics: { admissionId } satisfies SqliteSessionReclamationAdmissionDiagnostics,
        };
        admission = requested;
        const task = params
          .withWriteAdmission(async (refusal) => {
            if (completed) {
              return undefined;
            }
            if (refusal) {
              workerError ??= toStringifiedError(refusal.error);
            }
            worker.postMessage(
              {
                type: "admission",
                operationId,
                admissionId: requested.id,
                allowed: refusal === undefined && workerError === undefined,
              },
              [],
            );
            // Refusal holds the FIFO until exit. The owner publishes successful results
            // before returning this writer section; preliminary admissions release separately.
            await requested.released.promise;
            return completed && !workerError && !transportError && !params.getFailure?.()
              ? result
              : undefined;
          }, requested.diagnostics)
          .catch(async (failure: unknown) => {
            workerError ??= toStringifiedError(failure);
            if (!completed && admission === requested) {
              try {
                worker.postMessage(
                  { type: "admission", operationId, admissionId: requested.id, allowed: false },
                  [],
                );
              } catch (dispatchError) {
                fail(
                  new AggregateError(
                    [workerError, dispatchError],
                    "SQLite reclamation admission failed and Worker cleanup is uncertain; restart OpenClaw before deleting the owning agent",
                  ),
                );
              }
            }
            await requested.released.promise;
          });
        admissionTasks.push(task);
      } else if (message.type === "admission-release") {
        if (!admission || message.admissionId !== admission.id) {
          fail(
            new Error(
              "SQLite reclamation Worker released invalid write admission; cleanup is uncertain, restart OpenClaw before deleting the owning agent",
            ),
          );
          return;
        }
        const released = admission;
        admission = undefined;
        released.diagnostics.releaseCause = "worker-release";
        released.released.resolve();
      } else if (message.type === "reclaimed") {
        result = message.result;
        if (params.completion === "result") {
          finish();
        }
      }
    });
    worker.on("message", receive);
    worker.once("exit", exit);
    worker.once("error", error);
    worker.once("messageerror", messageError);
    try {
      params.dispatch?.();
    } catch (failure) {
      // Uncertain dispatch is terminal; never replay on a successor Worker.
      fail(failure);
    }
  });
}
