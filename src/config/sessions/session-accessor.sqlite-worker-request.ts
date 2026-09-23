import { AsyncLocalStorage } from "node:async_hooks";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-lifecycle.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { SqliteSessionReclamationAdmissionDiagnostics } from "./session-accessor.sqlite-contract.js";
import { revokeSqliteReclamationCommit } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  observeSqliteMutationWorkerEnd,
  terminateSqliteMutationWorker,
  type SqliteMutationWorkerEnd,
  type SqliteMutationWorkerTransport,
} from "./session-accessor.sqlite-worker-transport.js";

/** Register before the first await and drain through the parent's retained claim release. */
export function withSqliteMutationWorkerLifetime<T>(
  options: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  run: (request: {
    assertCurrent: () => void;
    commitGate: SharedArrayBuffer;
    signal: AbortSignal;
  }) => Promise<T>,
): Promise<T> {
  const completion = createDeferredCore();
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(options.env),
  );
  const commitGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const controller = new AbortController();
  const revoke = () => {
    revokeSqliteReclamationCommit(commitGate);
    controller.abort(new Error("SQLite mutation Worker request was revoked"));
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    state.assertCurrent();
  };
  const unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
    agentId: options.agentId,
    path: options.path,
    revoke,
    close: () => completion.promise,
  });
  let unregisterState: () => void;
  try {
    unregisterState = registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (!identity || identity.key === state.identity.key) {
          revoke();
          await completion.promise;
        }
      },
    });
  } catch (error) {
    unregisterAgent();
    throw error;
  }
  return Promise.resolve()
    .then(() => {
      assertCurrent();
      return run({ assertCurrent, commitGate, signal: controller.signal });
    })
    .finally(() => {
      revoke();
      completion.resolve();
      unregisterAgent();
      unregisterState();
    });
}

export type SqliteWorkerWriteAdmission<Result> = (
  run: (refusal?: { error: unknown }) => Promise<Result | undefined>,
  diagnostics: SqliteSessionReclamationAdmissionDiagnostics,
) => Promise<void>;

export type SqliteMutationWorkerValidationOwner = {
  database: OpenClawAgentReadOnlyDatabase;
  isCurrent: () => boolean;
};

export type SqliteMutationWorkerMessage<Result> =
  | { type: "commit-request"; operationId: number }
  | { type: "admission-request" | "admission-release"; operationId: number; admissionId: number }
  | {
      type: "reclaimed";
      operationId: number;
      result: Result;
      settled: true;
      validation?: OpenClawAgentDatabaseValidation;
    };

/** Share request authority, not connection lifetime: cold mutations join exit; sweeps join each result. */
export function runSqliteMutationWorkerRequest<Result>(params: {
  transport: SqliteMutationWorkerTransport;
  operationId: number;
  completion: "result" | "exit";
  onCommitRequest: () => void;
  withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
  validationOwner?: SqliteMutationWorkerValidationOwner;
  dispatch?: () => void;
  getFailure?: () => Error | undefined;
  onExit?: (code: number) => void;
}): Promise<Result> {
  const { transport, operationId } = params;
  const worker = transport.channel;
  return new Promise((resolve, reject) => {
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun Worker fix ships.
    // TODO(bun): Rely on the Worker's native async resource once Bun ships
    // https://github.com/oven-sh/bun/pull/42593.
    const runInOperationContext = AsyncLocalStorage.snapshot();
    let result: Result | undefined;
    let validation: OpenClawAgentDatabaseValidation | undefined;
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
    const terminate = () => {
      void terminateSqliteMutationWorker(transport).catch((failure: unknown) => {
        workerError = new AggregateError(
          [workerError ?? transportError, failure].filter((error) => error !== undefined),
          "SQLite mutation Worker termination failed",
          { cause: failure },
        );
      });
    };
    const fail = (error: unknown) => {
      workerError ??= toStringifiedError(error);
      terminate();
    };
    const error = (failure: unknown) =>
      runInOperationContext(() => {
        // Parent authority failures take precedence over the Worker's generic unwind error.
        transportError ??= toStringifiedError(failure);
      });
    const messageError = (failure: unknown) =>
      runInOperationContext(() => {
        error(failure);
        terminate();
      });
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
      stopObservingEnd();
      worker.off("error", error);
      worker.off("messageerror", messageError);
      void Promise.all(admissionTasks)
        .then(() => {
          const failure = workerError ?? transportError ?? params.getFailure?.();
          if (failure) {
            reject(failure);
          } else if (code !== undefined && code !== 0) {
            reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
          } else if (result === undefined) {
            reject(new Error("SQLite session reclamation Worker exited without results"));
          } else {
            if (validation && params.validationOwner?.isCurrent()) {
              adoptOpenClawAgentDatabaseValidation(params.validationOwner.database, validation);
            }
            resolve(result);
          }
        })
        .catch(reject);
    };
    const ended = (ending: SqliteMutationWorkerEnd) =>
      runInOperationContext(() => {
        if (ending.kind === "native-exit") {
          params.onExit?.(ending.code);
          finish(ending.code);
        } else {
          if (ending.kind === "task-failed") {
            transportError ??= ending.error;
          }
          finish();
        }
      });
    // Worker events inherit its first caller; each request must retain its own authority context.
    const receiveInOperationContext = (message: SqliteMutationWorkerMessage<Result>) => {
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
            const allowed = refusal === undefined && workerError === undefined;
            worker.postMessage(
              {
                type: "admission",
                operationId,
                admissionId: requested.id,
                allowed,
                validation:
                  allowed && params.validationOwner?.isCurrent()
                    ? getOpenClawAgentDatabaseValidation(params.validationOwner.database)
                    : undefined,
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
        if (!message.settled) {
          fail(new Error("SQLite reclamation Worker omitted operation settlement"));
          return;
        }
        result = message.result;
        validation = message.validation;
        if (params.completion === "result") {
          finish();
        }
      }
    };
    const receive = (message: SqliteMutationWorkerMessage<Result>) =>
      runInOperationContext(receiveInOperationContext, message);
    worker.on("message", receive);
    const stopObservingEnd = observeSqliteMutationWorkerEnd(transport, ended);
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
