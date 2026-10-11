import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import path from "node:path";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { retainSqliteWorkerErrorCode } from "../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as creationClaims from "./agent-creation-claim.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import { captureAgentDatabaseAdmission } from "./agent-database-admission.js";
import {
  assertAgentDeletionExecutionCleanupAccess,
  getAgentDeletionDatabaseCleanup,
  registerAgentDeletionExecutionCleanup,
} from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import {
  drainAgentDatabaseResources,
  registerOpenClawAgentDatabaseAsyncResource,
} from "./openclaw-agent-db-resources.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseExecutionScope,
  AgentDatabaseFileExecutionOwner,
  AgentDatabaseNativeGeneration,
  OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import {
  type AgentDatabaseExecutionPreparedTarget,
  assertBorrowedAgentDatabaseFileIdentity,
  captureBorrowedAgentDatabaseGenerationClaim,
  captureNativeAgentDatabaseExecutionIdentity,
  supportsAgentDatabaseExecutionScope,
} from "./openclaw-agent-execution-scope.js";
import { createAgentDatabaseAcceptedWork } from "./openclaw-agent-execution-work.js";
import {
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  LEASE_CONTENTION_RETRY_TIMEOUT_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type AgentDatabaseExecutionState = {
  owners: Map<string, AgentDatabaseFileExecutionOwner>;
  // LRU entries keep their slots during eviction and after failed cleanup.
  idle: Set<AgentDatabaseFileExecutionOwner>;
};

const log = createSubsystemLogger("state/agent-db");
const MAX_IDLE_EXECUTORS = 4;
const runInExecutionOwnerContext = AsyncLocalStorage.snapshot();

export function createAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  prepared: AgentDatabaseExecutionPreparedTarget,
  executionState: AgentDatabaseExecutionState,
): OpenClawAgentDatabaseExecution {
  const executions = executionState.owners;
  const { agentId, pathname, identity, initialIdentity, expectedCreationIdentity } = prepared;
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const executionOptions = { agentId, path: pathname, env: context.environment };
  const creationClaim = creationClaims.captureAgentCreationClaim(options);
  const aliases = new Map<string, () => void>();
  const assertAgentAdmitted = captureAgentDatabaseAdmission(agentId, { env: context.environment });
  let retired = false;
  let revoked = false;
  let borrowers = 0;
  const acceptedWork = createAgentDatabaseAcceptedWork();
  let creationIdentity = expectedCreationIdentity;
  let creationBorrowers = 0;
  let generation: AgentDatabaseNativeGeneration | undefined;
  let fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  let nativeClosing: Promise<void> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  let unregisterShared: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDrainListener: Disposable | undefined;

  const acceptFileIdentity = (received: AgentDatabaseExecutionFileIdentity) => {
    if (
      fileIdentity &&
      (fileIdentity.physicalIdentity !== received.physicalIdentity ||
        fileIdentity.birthtime !== received.birthtime)
    ) {
      throw new Error("Agent database execution belongs to another physical file");
    }
    fileIdentity ??= Object.freeze({ ...received });
  };

  const clearIdleTimer = () => {
    idleDrainListener?.[Symbol.dispose]();
    idleDrainListener = undefined;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const reportCleanupFailure = (error: unknown) => {
    // Diagnostic failures cannot turn a committed command into a replayable failure.
    try {
      log.warn(`Agent database idle cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // The resource owner still retains the cleanup failure.
    }
  };
  const finishRetirement = () => {
    retired = true;
    if (executions.get(pathname) !== owner) {
      return;
    }
    unregisterAgent();
    unregisterShared?.();
  };

  const assertCurrent = () => {
    if (
      retired ||
      executions.get(pathname) !== owner ||
      !supportsAgentDatabaseExecutionScope(executionOptions)
    ) {
      throw new AgentDatabaseExecutionAdmissionClosedError(
        "Agent database execution admission is closed",
      );
    }
    assertAgentDeletionExecutionCleanupAccess(owner, executionOptions);
    context.admission.assertCurrent();
    assertAgentAdmitted();
    creationClaim?.assertCurrent();
  };
  const closeNative = (expected?: AgentDatabaseNativeGeneration): Promise<void> => {
    if (expected && generation !== expected) {
      return Promise.resolve();
    }
    clearIdleTimer();
    if (nativeClosing) {
      return nativeClosing;
    }
    const captured = generation;
    if (!captured) {
      return Promise.resolve();
    }
    const result = captured
      .close()
      .then(
        () => {
          if (generation === captured) {
            generation = undefined;
            cleanupFailure = undefined;
            executionState.idle.delete(owner);
          }
        },
        (error: unknown) => {
          cleanupFailure = { error };
          throw error;
        },
      )
      .finally(() => {
        if (nativeClosing === result) {
          nativeClosing = undefined;
        }
      });
    nativeClosing = result;
    return result;
  };
  async function run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    retireNativeOnFailure = false,
    createIfMissing = false,
    creatingTarget?: DatabasePathIdentity,
    signal?: AbortSignal,
    readmitSchema = false,
    contentionDeadline?: number,
  ): Promise<T | undefined> {
    const pending = agentDatabaseLifecycle.pending.get(pathname);
    if (pending) {
      if (creatingTarget && !fileIdentity) {
        throw new Error("Agent creation cannot adopt another pending opener");
      }
      if (pending.agentId !== agentId) {
        throw new Error(`Agent database ${pathname} is opening for ${pending.agentId}`);
      }
      await pending.promise;
      pending.controller.signal.throwIfAborted();
      assertCallerCurrent();
    }
    if (nativeClosing) {
      await nativeClosing;
      assertCallerCurrent();
    }
    // Retire a failed or refused native generation before admitting replacement work.
    if (cleanupFailure || generation?.failure()) {
      await closeNative();
      assertCurrent();
      source.assertCurrent();
      assertCallerCurrent();
      signal?.throwIfAborted();
    }
    if (!generation) {
      const created = createAgentDatabaseNativeGeneration(
        agentId,
        identity.canonicalPath,
        context,
        assertCurrent,
        () => {
          if (executions.get(pathname) !== owner || generation !== created || !nativeClosing) {
            throw new Error("Agent cleanup no longer owns its original execution reference");
          }
        },
        expectedIdentity ?? fileIdentity,
        acceptFileIdentity,
        () => {
          const retained = owner.borrow(pathname);
          return () => retained.release();
        },
        fileIdentity ? undefined : (creationIdentity ?? creatingTarget),
        creationClaim?.witness,
      );
      generation = created;
    }
    const current = generation;
    let entered = false;
    try {
      const result = await current.run(
        source,
        (scope) => {
          entered = true;
          return operation(scope);
        },
        assertCallerCurrent,
        createIfMissing,
        signal,
        readmitSchema,
      );
      // A peer's intentional native close can finish while this admitted operation settles.
      if (generation === current && !nativeClosing && current.failure()) {
        await owner.close().catch(reportCleanupFailure);
      }
      return result;
    } catch (error) {
      const nativeFailure = current.failure();
      const contended = !entered && isSqliteLockError(error);
      if (generation === current && (nativeFailure || retireNativeOnFailure)) {
        try {
          if (nativeFailure === "native" && !contended && !nativeClosing) {
            await owner.close();
          } else {
            // The rejected broker scope has settled; only its captured native owner is retired.
            await closeNative(current);
          }
        } catch (cleanupError) {
          throw retainSqliteWorkerErrorCode(
            new AggregateError([error, cleanupError], "Agent operation and cleanup failed", {
              cause: error,
            }),
            error,
          );
        }
      }
      if (contended) {
        const deadline =
          contentionDeadline ?? performance.now() + LEASE_CONTENTION_RETRY_TIMEOUT_MS;
        if (contentionDeadline === undefined) {
          log.warn(
            "Agent database execution admission delayed by SQLite lock contention; retrying before execution.",
          );
        }
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          await sleepWithAbort(Math.min(LEASE_CONTENTION_RETRY_MS, remaining), signal);
          assertCurrent();
          source.assertCurrent();
          assertCallerCurrent();
          if (performance.now() >= deadline) {
            throw error;
          }
          return run(
            source,
            operation,
            assertCallerCurrent,
            expectedIdentity,
            retireNativeOnFailure,
            createIfMissing,
            creatingTarget,
            signal,
            readmitSchema,
            deadline,
          );
        }
      }
      throw error;
    }
  }
  const owner: AgentDatabaseFileExecutionOwner = {
    kind: "file",
    agentId,
    get sharedDatabaseKey() {
      return context.admission.identity.key;
    },
    get creationIdentity() {
      return creationIdentity;
    },
    borrow(borrowedPath, expected, creating, requestedPath) {
      const cleanup = getAgentDeletionDatabaseCleanup({ ...executionOptions, path: borrowedPath });
      if (cleanup?.worker && !generation?.isPrepared()) {
        registerAgentDeletionExecutionCleanup(
          owner,
          { ...executionOptions, path: borrowedPath },
          () => drainAgentDatabaseResources({ path: borrowedPath, agentId }, async () => {}),
        );
      }
      const expectedIdentity = expected ? Object.freeze({ ...expected }) : undefined;
      const creatingTarget = creating ? Object.freeze({ ...creating }) : undefined;
      const assertReferenceCurrent = (nativeIdentity?: AgentDatabaseExecutionFileIdentity) => {
        assertCurrent();
        assertBorrowedAgentDatabaseFileIdentity({
          borrowedPath,
          identity,
          creatingTarget,
          fileIdentity,
          expectedIdentity,
          nativeIdentity,
        });
      };
      assertReferenceCurrent();
      if (creatingTarget && !creationIdentity && !fileIdentity && generation) {
        throw new Error("Agent creation cannot capture another pending native opener");
      }
      retainAlias(borrowedPath);
      if (requestedPath !== undefined) {
        retainAlias(path.resolve(requestedPath));
      }
      observeOpenClawDatabaseMaintenanceResource(aliases.get(pathname));
      borrowers += 1;
      clearIdleTimer();
      if (!nativeClosing && !cleanupFailure) {
        executionState.idle.delete(owner);
      }
      if (creatingTarget) {
        creationIdentity ??= creatingTarget;
        creationBorrowers += 1;
      }
      const assertCreationReference = (create: boolean) => {
        if (creatingTarget && !fileIdentity && !create) {
          throw new Error("Originally observed agent target requires creating admission first");
        }
        if (creationBorrowers && !fileIdentity && (!create || !creatingTarget)) {
          throw new Error(
            "Originally observed agent target requires its captured creating reference",
          );
        }
      };
      let released = false;
      let release: Promise<void> | undefined;
      const borrower = Symbol("agent database borrower");

      const assertBorrowed = () => {
        if (released) {
          throw new Error("Agent database execution reference is released");
        }
        cleanup?.assertCurrentHost();
        assertReferenceCurrent();
      };
      const captureGenerationClaim = () =>
        captureBorrowedAgentDatabaseGenerationClaim(assertBorrowed, () => generation);
      const borrowed: OpenClawAgentDatabaseExecution = {
        agentId,
        path: borrowedPath,
        get fileIdentity() {
          assertBorrowed();
          return fileIdentity;
        },
        async adoptNativeDatabase(database) {
          const adoption = (async () => {
            const native = captureNativeAgentDatabaseExecutionIdentity(
              database,
              agentId,
              identity.canonicalPath,
              assertBorrowed,
            );
            // A refused prepare can retain an unopened generation with the old absence witness.
            if (generation && !fileIdentity) {
              await closeNative(generation);
              native.assertCurrent();
            }
            assertReferenceCurrent(native.fileIdentity);
            acceptFileIdentity(native.fileIdentity);
          })();
          acceptedWork.pending.set(adoption, { borrower });
          try {
            await adoption;
          } finally {
            acceptedWork.pending.delete(adoption);
          }
        },
        assertCurrent: assertBorrowed,
        captureGenerationClaim,
        capturePreparedGenerationClaim() {
          assertBorrowed();
          if (
            agentDatabaseLifecycle.pending.has(pathname) ||
            nativeClosing ||
            cleanupFailure ||
            generation?.failure() ||
            !generation?.isPrepared()
          ) {
            return undefined;
          }
          return captureGenerationClaim();
        },
        async prepare(source, signal, preparationOptions) {
          assertBorrowed();
          assertCreationReference(true);
          const result = run(
            source,
            async () => undefined,
            (nativeIdentity) => {
              assertReferenceCurrent(nativeIdentity);
              assertCreationReference(true);
            },
            expectedIdentity,
            false,
            true,
            creatingTarget,
            signal,
            preparationOptions?.readmitSchema,
          );
          acceptedWork.pending.set(result, { borrower });
          void result.finally(() => acceptedWork.pending.delete(result)).catch(() => undefined);
          await result;
        },
        async runExisting(source, operation, runOptions) {
          const capturedGeneration = released ? undefined : generation;
          const completion = createDeferredCore();
          acceptedWork.pending.set(completion.promise, { borrower });
          try {
            assertBorrowed();
            assertCreationReference(false);
            const execute = () =>
              run(
                source,
                operation,
                (nativeIdentity) => {
                  assertReferenceCurrent(nativeIdentity);
                  assertCreationReference(false);
                },
                expectedIdentity,
                runOptions?.retireNativeOnFailure,
              );
            if (runOptions?.withAdmission) {
              const queuedReadAbort = new AbortController();
              acceptedWork.pending.set(completion.promise, { borrower, queuedReadAbort });
              return await runOptions.withAdmission(execute, queuedReadAbort.signal);
            }
            return await execute();
          } catch (error) {
            if (runOptions?.retireNativeOnFailure && capturedGeneration) {
              try {
                await closeNative(capturedGeneration);
              } catch (cleanupError) {
                throw retainSqliteWorkerErrorCode(
                  new AggregateError(
                    [error, cleanupError],
                    "Agent execution refusal and native cleanup failed",
                    { cause: error },
                  ),
                  error,
                );
              }
            }
            throw error;
          } finally {
            acceptedWork.pending.delete(completion.promise);
            completion.resolve();
          }
        },
        release() {
          released = true;
          acceptedWork.cancelReadAdmissions(borrower);
          return (release ??= (async () => {
            await acceptedWork.settleBorrower(borrower);
            if (
              creatingTarget &&
              --creationBorrowers === 0 &&
              !fileIdentity &&
              !nativeClosing &&
              !cleanupFailure
            ) {
              if (generation) {
                // Source refusal can leave an unaccepted generation allocated before native open.
                await closeNative(generation).catch(reportCleanupFailure);
              }
              if (!creationBorrowers && !generation && !nativeClosing && !cleanupFailure) {
                creationIdentity = undefined;
              }
            }
            borrowers -= 1;
            if (borrowers !== 0 || retired || cleanupFailure) {
              return;
            }
            const drainSignal = getGatewayRestartDrainSignal();
            const canRetain = () => generation && !nativeClosing && !drainSignal.aborted;
            try {
              for (const idle of executionState.idle) {
                if (!canRetain() || executionState.idle.size < MAX_IDLE_EXECUTORS) {
                  break;
                }
                if (borrowers !== 0 || retired || executionState.idle.has(owner)) {
                  return;
                }
                await idle.closeIdle();
              }
            } catch (error) {
              reportCleanupFailure(error);
            }
            if (borrowers !== 0 || retired || executionState.idle.has(owner)) {
              return;
            }
            if (canRetain() && executionState.idle.size < MAX_IDLE_EXECUTORS) {
              executionState.idle.add(owner);
              const timer = runInExecutionOwnerContext(() =>
                setTimeout(() => {
                  if (idleTimer !== timer || !executionState.idle.has(owner)) {
                    return;
                  }
                  void owner.closeIdle().catch(reportCleanupFailure);
                }, SQLITE_IDLE_HANDLE_TTL_MS),
              );
              idleTimer = timer;
              timer.unref();
              // Restart drain retires idle generations without interrupting accepted writers.
              idleDrainListener = addAbortListener(drainSignal, () => {
                runInExecutionOwnerContext(() => {
                  void owner.closeIdle().catch(reportCleanupFailure);
                });
              });
              return;
            }
            // The completed command stays acknowledged; the resource owner retains cleanup.
            await owner.closeIdle().catch(reportCleanupFailure);
          })());
        },
      };
      cleanup?.registerClose(() => borrowed.release());
      return borrowed;
    },
    async closeIdle() {
      await closeNative();
      // A reborrow may have retained the owner or started its next native generation.
      if (borrowers === 0 && !generation) {
        finishRetirement();
      }
    },
    close() {
      retired = true;
      acceptedWork.cancelReadAdmissions();
      closing ??= (async () => {
        await closeNative();
        finishRetirement();
      })().catch((error: unknown) => {
        closing = undefined;
        if (!revoked) {
          // Failed cleanup retains this generation and lease. Let later borrowers retry;
          // explicit revocation still prevents new work.
          retired = false;
        }
        throw error;
      });
      return closing;
    },
  };
  const revoke = () => {
    revoked = true;
    retired = true;
    acceptedWork.cancelReadAdmissions();
    clearIdleTimer();
  };
  const unregisterAgent = () => {
    for (const [alias, unregister] of aliases) {
      if (executions.get(alias) === owner) {
        executions.delete(alias);
      }
      unregister();
    }
    aliases.clear();
  };
  const retainAlias = (alias: string) => {
    if (aliases.has(alias)) {
      return;
    }
    // Cleanup keeps captured locators even if a symlink is later removed or retargeted.
    const register = () =>
      registerOpenClawAgentDatabaseAsyncResource(
        {
          agentId,
          path: alias,
          revoke,
          close: () => acceptedWork.closeAccepted(() => owner.close()),
          retireAfterResources: true,
        },
        options,
      );
    // One claim owns the executor; later aliases only select that owner for cleanup.
    const unregister =
      aliases.size === 0 ? register() : runOutsideOpenClawDatabaseMaintenanceScope(register);
    aliases.set(alias, unregister);
    executions.set(alias, owner);
  };
  try {
    retainAlias(pathname);
    retainAlias(identity.canonicalPath);
    // Config changes do not drain captured executors; unused stores expire normally.
    // Callers resolve new routing, while accepted work keeps its original physical store.
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (sharedIdentity) => {
        if (!sharedIdentity || sharedIdentity.key === context.admission.identity.key) {
          await acceptedWork.closeAccepted(() => owner.close());
        }
      },
    });
    return owner.borrow(
      pathname,
      initialIdentity,
      expectedCreationIdentity,
      prepared.requestedPath,
    );
  } catch (error) {
    unregisterAgent();
    unregisterShared?.();
    throw error;
  }
}
