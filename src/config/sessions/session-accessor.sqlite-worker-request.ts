import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject, toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  type StateDatabaseSchemaLease,
} from "../../infra/gateway-state-owner.js";
import { retainSqliteWriteAdmissionService } from "../../infra/sqlite-transaction.js";
import { createSqliteDatabaseAdmissionRelay } from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-lifecycle.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  captureOpenClawAgentDatabaseValidationTransfer,
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
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
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();
  const completion = createDeferredCore();
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(options.env),
  );
  const commitGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const controller = new AbortController();
  const revoke = () => {
    revokeSqliteReclamationCommit(commitGate);
    controller.abort(
      callerSignal?.aborted
        ? callerSignal.reason
        : new Error("SQLite mutation Worker request was revoked"),
    );
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
  callerSignal?.addEventListener("abort", revoke, { once: true });
  if (callerSignal?.aborted) {
    revoke();
  }
  return Promise.resolve()
    .then(() => {
      assertCurrent();
      return run({ assertCurrent, commitGate, signal: controller.signal });
    })
    .finally(() => {
      callerSignal?.removeEventListener("abort", revoke);
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

export type SqliteMutationWorkerValidationOwner =
  | {
      database: OpenClawAgentReadOnlyDatabase;
      isCurrent: () => boolean;
    }
  | {
      source: { agentId: string; path: string };
      claim: AgentDatabaseGenerationClaim;
    };

export type SqliteMutationWorkerMessage<Result> =
  | { type: "refused"; operationId: number; settled: true }
  | { type: "commit-request"; operationId: number }
  | { type: "admission-request" | "admission-release"; operationId: number; admissionId: number }
  | {
      type: "reclaimed";
      operationId: number;
      result: Result;
      settled: true;
      validation?: OpenClawAgentDatabaseValidation;
    };

/** Transport settlement is separate from the caller's refused authority. */
export class SqliteMutationWorkerSettledRefusal extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

/** Share request authority, not connection lifetime: cold mutations join exit; sweeps join each result. */
export function runSqliteMutationWorkerRequest<Result>(params: {
  transport: SqliteMutationWorkerTransport;
  operationId: number;
  completion: "result" | "exit";
  databaseAuthority?: {
    databasePath: string;
    creationPaths: readonly string[];
    maintenanceScope?: OpenClawDatabaseMaintenanceScope;
    assertCurrent(): void;
  };
  onCommitRequest: () => void;
  withWriteAdmission: SqliteWorkerWriteAdmission<Result>;
  validationOwner?: SqliteMutationWorkerValidationOwner;
  /** Opening proof remains revocable and is adopted only against the worker's native identity. */
  readOpeningValidation?: () => OpenClawAgentDatabaseValidation | undefined;
  dispatch?: () => void;
  getFailure?: () => Error | undefined;
  onExit?: (code: number) => void;
}): Promise<Result> {
  const { transport, operationId } = params;
  const validationOwner = params.validationOwner;
  if (validationOwner && "source" in validationOwner) {
    validationOwner.claim.assertCurrent();
  }
  const receiveValidation =
    validationOwner && "source" in validationOwner
      ? captureOpenClawAgentDatabaseValidationTransfer(validationOwner.source)
      : undefined;
  const readValidation = () => {
    if (!validationOwner) {
      return params.readOpeningValidation?.();
    }
    if ("database" in validationOwner) {
      return validationOwner.isCurrent()
        ? getOpenClawAgentDatabaseValidation(validationOwner.database)
        : undefined;
    }
    validationOwner.claim.assertCurrent();
    const validation = getOpenClawAgentDatabaseValidationForTransfer(validationOwner.source);
    return validation?.identity === validationOwner.claim.identity ? validation : undefined;
  };
  const adoptValidation = (validation: OpenClawAgentDatabaseValidation) => {
    if (!validationOwner) {
      return;
    }
    if ("database" in validationOwner) {
      if (validationOwner.isCurrent()) {
        adoptOpenClawAgentDatabaseValidation(validationOwner.database, validation);
      }
      return;
    }
    try {
      validationOwner.claim.assertCurrent();
    } catch {
      // Retirement after settlement cannot revive proof or reject an acknowledged result.
      return;
    }
    receiveValidation?.(validationOwner.claim.identity, validation);
  };
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
    let settledRefusal = false;
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
            reject(settledRefusal ? new SqliteMutationWorkerSettledRefusal(failure) : failure);
          } else if (code !== undefined && code !== 0) {
            reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
          } else if (result === undefined) {
            reject(new Error("SQLite session reclamation Worker exited without results"));
          } else {
            if (validation) {
              adoptValidation(validation);
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
            const authority = params.databaseAuthority;
            const assertCreationCurrent = () => {
              if (
                !allowed ||
                admission !== requested ||
                completed ||
                workerError ||
                transportError ||
                params.getFailure?.()
              ) {
                throw new Error("SQLite reclamation creation grant is no longer current");
              }
              authority?.assertCurrent();
            };
            const metadata =
              allowed && authority
                ? createSqliteDatabaseAdmissionRelay(assertCreationCurrent)
                : undefined;
            const creationPaths = new Set(
              authority?.creationPaths.map(resolveIdentityPathViaExistingAncestorSync),
            );
            if (metadata && authority) {
              let schemaLease: StateDatabaseSchemaLease | undefined;
              const assertAccess = () => {
                assertCreationCurrent();
                authority.maintenanceScope?.assertAdmission();
                assertStateDatabaseAccessAllowed(authority.databasePath, {
                  maintenanceScope: authority.maintenanceScope,
                  schemaLease,
                });
              };
              metadata.bindDatabaseAuthority({
                databasePath: authority.databasePath,
                assertRequest: assertCreationCurrent,
                assertAccess,
                assertCreate(location) {
                  if (!creationPaths.has(resolveIdentityPathViaExistingAncestorSync(location))) {
                    throw new Error(
                      "SQLite reclamation creation target differs from its admitted databases",
                    );
                  }
                },
                acquireSchema() {
                  assertAccess();
                  const acquire = () => acquireStateDatabaseSchemaLease(authority.databasePath);
                  const lease = authority.maintenanceScope
                    ? authority.maintenanceScope.run(acquire)
                    : acquire();
                  schemaLease = lease;
                  authority.maintenanceScope?.own(lease, "shared-resources", () => lease.release());
                  return {
                    assertCurrent() {
                      assertAccess();
                      lease.assertCurrent();
                    },
                    release: () => lease.release(),
                  };
                },
              });
            }
            const releaseService =
              metadata && authority
                ? retainSqliteWriteAdmissionService(authority.creationPaths, () =>
                    metadata.service(),
                  )
                : undefined;
            try {
              worker.postMessage(
                {
                  type: "admission",
                  operationId,
                  admissionId: requested.id,
                  allowed,
                  validation: allowed ? readValidation() : undefined,
                  ...(metadata ? { databaseAdmissionPort: metadata.port } : {}),
                },
                metadata ? [metadata.port] : [],
              );
              // Refusal holds the FIFO until exit. The owner publishes successful results
              // before returning this writer section; preliminary admissions release separately.
              await requested.released.promise;
              if (metadata?.failure) {
                throw toErrorObject(metadata.failure, "SQLite worker admission failed");
              }
              return completed && !workerError && !transportError && !params.getFailure?.()
                ? result
                : undefined;
            } finally {
              metadata?.finish();
              releaseService?.();
            }
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
      } else if (message.type === "refused") {
        if (!message.settled || params.completion !== "result") {
          fail(new Error("SQLite reclamation Worker omitted refusal settlement"));
          return;
        }
        settledRefusal = true;
        workerError ??= new Error("SQLite reclamation Worker request was refused");
        finish();
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
