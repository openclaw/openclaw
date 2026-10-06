import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { retainSqliteWorkerErrorCode } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import * as creationClaims from "./agent-creation-claim.js";
import { captureAgentDatabaseAdmission } from "./agent-database-admission.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  AgentDatabaseExecutionAdmissionClosedError,
  type AgentDatabaseExecutionFileIdentity,
  type AgentDatabaseExecutionScope,
  type AgentDatabaseFileExecutionOwner,
  type AgentDatabaseNativeGeneration,
  type AgentDatabaseRequestExecutionSource,
  type OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
import {
  createAgentDatabaseExecutionCapture,
  type IncognitoAgentExecutionOwner,
} from "./openclaw-agent-execution-incognito.js";
import {
  captureBorrowedAgentDatabaseGenerationClaim,
  createAgentDatabaseNativeGeneration,
  supportsAgentDatabaseExecutionScope,
  supportsOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-native.js";
import {
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  LEASE_CONTENTION_RETRY_TIMEOUT_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";

export { supportsOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-native.js";

const log = createSubsystemLogger("state/agent-db");
// References are derived; the canonical agent and shared resource owners govern retirement.
const executionState = resolveGlobalSingleton<{
  owners: Map<string, AgentDatabaseFileExecutionOwner | IncognitoAgentExecutionOwner>;
  // The slot stays occupied during eviction and after failed cleanup.
  idle?: AgentDatabaseFileExecutionOwner;
}>(Symbol.for("openclaw.agentDatabaseExecutionOwners"), () => ({ owners: new Map() }));
const executions = executionState.owners;
const runInExecutionOwnerContext = AsyncLocalStorage.snapshot();

/** File captures stay synchronous; explicit ephemeral targets await their pinned actor. */
export const captureOpenClawAgentDatabaseExecution = createAgentDatabaseExecutionCapture(
  executions,
  captureFileAgentDatabaseExecution,
);

/** Borrow before callers yield; native opening stays lazy and release joins owned work. */
function captureFileAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: {
    expectedIdentity?: AgentDatabaseExecutionFileIdentity;
    expectedCreationIdentity?: DatabasePathIdentity;
    /** The caller's locator before it pinned options.path to the physical file. */
    requestedPath?: string;
  } = {},
): OpenClawAgentDatabaseExecution {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  creationClaims.assertAgentCreationClaimAliases(options);
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    throw new Error("This agent database scope still requires its existing native owner");
  }
  let existing = executions.get(pathname);
  const expectedCreationIdentity = constraints.expectedCreationIdentity
    ? Object.freeze({ ...constraints.expectedCreationIdentity })
    : undefined;
  if (!existing || expectedCreationIdentity) {
    const identity = readDatabasePathIdentitySync(pathname);
    existing ??= executions.get(identity.canonicalPath);
    if (expectedCreationIdentity) {
      const capturesAbsence = expectedCreationIdentity.key.startsWith("path:");
      const observed =
        capturesAbsence && existing?.kind === "file" ? existing.creationIdentity : identity;
      if (
        constraints.expectedIdentity ||
        (capturesAbsence &&
          (agentDatabaseLifecycle.databases.has(pathname) ||
            agentDatabaseLifecycle.pending.has(pathname))) ||
        (!capturesAbsence &&
          (!expectedCreationIdentity.key.startsWith("file:") ||
            typeof expectedCreationIdentity.birthtime !== "string")) ||
        observed?.key !== expectedCreationIdentity.key ||
        observed.canonicalPath !== expectedCreationIdentity.canonicalPath ||
        observed.birthtime !== expectedCreationIdentity.birthtime
      ) {
        throw new Error("Agent creation no longer owns its originally observed target");
      }
    }
    if (!existing) {
      return createAgentDatabaseExecution(options, {
        agentId,
        pathname,
        identity,
        initialIdentity: constraints.expectedIdentity,
        expectedCreationIdentity,
        requestedPath: constraints.requestedPath,
      });
    }
  }
  if (existing.kind !== "file") {
    throw new Error("Agent namespace belongs to an incognito execution owner");
  }
  if (existing.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
  const env =
    process.platform === "win32"
      ? cloneEnvWithPlatformSemantics(options.env ?? process.env)
      : options.env;
  const state = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(env));
  if (existing.sharedDatabaseKey !== state.admission.identity.key) {
    throw new Error(
      "Agent database execution belongs to another shared-state database; drain its existing resources before changing the state directory.",
    );
  }
  return existing.borrow(
    pathname,
    constraints.expectedIdentity,
    expectedCreationIdentity,
    constraints.requestedPath,
  );
}

function createAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  prepared: {
    agentId: string;
    pathname: string;
    identity: DatabasePathIdentity;
    initialIdentity?: AgentDatabaseExecutionFileIdentity;
    expectedCreationIdentity?: DatabasePathIdentity;
    requestedPath?: string;
  },
): OpenClawAgentDatabaseExecution {
  const { agentId, pathname, identity, initialIdentity, expectedCreationIdentity } = prepared;
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const executionOptions = { agentId, path: pathname, env: context.environment };
  const creationClaim = creationClaims.captureAgentCreationClaim(options);
  const aliases = new Map<string, () => void>();
  const assertAgentAdmitted = captureAgentDatabaseAdmission(agentId, { env: context.environment });
  let retired = false;
  let revoked = false;
  let borrowers = 0;
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
            if (executionState.idle === owner) {
              executionState.idle = undefined;
            }
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
      for (let idle = executionState.idle; idle && idle !== owner; idle = executionState.idle) {
        await idle.closeIdle();
        assertCurrent();
        source.assertCurrent();
        assertCallerCurrent();
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
          (received) => {
            if (
              fileIdentity &&
              (fileIdentity.physicalIdentity !== received.physicalIdentity ||
                fileIdentity.birthtime !== received.birthtime)
            ) {
              throw new Error("Agent database execution belongs to another physical file");
            }
            fileIdentity ??= Object.freeze({ ...received });
          },
          fileIdentity ? undefined : (creationIdentity ?? creatingTarget),
          creationClaim?.witness,
        );
        generation = created;
      }
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
      );
      if (generation === current && current.failure()) {
        try {
          await owner.close();
        } catch (error) {
          reportCleanupFailure(error);
        }
      }
      return result;
    } catch (error) {
      const nativeFailure = current.failure();
      const contended = !entered && isSqliteLockError(error);
      if (generation === current && (nativeFailure || retireNativeOnFailure)) {
        try {
          if (nativeFailure === "native" && !contended) {
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
      const expectedIdentity = expected ? Object.freeze({ ...expected }) : undefined;
      const creatingTarget = creating ? Object.freeze({ ...creating }) : undefined;
      const assertReferenceCurrent = (nativeIdentity?: AgentDatabaseExecutionFileIdentity) => {
        assertCurrent();
        if (!fileIdentity || creatingTarget) {
          const current = readDatabasePathIdentitySync(borrowedPath);
          if (
            current.canonicalPath !== identity.canonicalPath ||
            (creatingTarget?.key.startsWith("file:") &&
              (current.key !== creatingTarget.key ||
                current.birthtime !== creatingTarget.birthtime))
          ) {
            throw new Error("Agent database borrower changed its originally observed target");
          }
        }
        if (
          fileIdentity &&
          expectedIdentity &&
          (fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity ||
            (fileIdentity.birthtime !== undefined &&
              expectedIdentity.birthtime !== undefined &&
              fileIdentity.birthtime !== expectedIdentity.birthtime))
        ) {
          throw new Error("Agent database borrower belongs to another physical file");
        }
        const file = fileIdentity ?? expectedIdentity;
        const birthtime = fileIdentity?.birthtime ?? expectedIdentity?.birthtime;
        if (file) {
          if (
            nativeIdentity &&
            (nativeIdentity.physicalIdentity !== file.physicalIdentity ||
              (birthtime !== undefined && nativeIdentity.birthtime !== birthtime))
          ) {
            throw new Error("Agent database borrower belongs to another physical file");
          }
          // The native owner validates its own path last; a borrowed alias has a separate lifetime.
          if (!nativeIdentity || borrowedPath !== nativeIdentity.nativeLocation) {
            assertExistingDatabaseIdentity(
              borrowedPath,
              `file:${file.physicalIdentity}`,
              birthtime,
            );
          }
        }
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
      if (executionState.idle === owner && !nativeClosing && !cleanupFailure) {
        executionState.idle = undefined;
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
      const pending = new Set<Promise<unknown>>();

      const assertBorrowed = () => {
        if (released) {
          throw new Error("Agent database execution reference is released");
        }
        assertReferenceCurrent();
      };
      const captureGenerationClaim = () =>
        captureBorrowedAgentDatabaseGenerationClaim(assertBorrowed, () => generation);
      return {
        agentId,
        path: borrowedPath,
        get fileIdentity() {
          assertBorrowed();
          return fileIdentity;
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
        async prepare(source, signal) {
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
          );
          pending.add(result);
          void result.finally(() => pending.delete(result)).catch(() => undefined);
          await result;
        },
        async runExisting(source, operation, runOptions) {
          const capturedGeneration = generation;
          const completion = createDeferredCore();
          pending.add(completion.promise);
          try {
            assertBorrowed();
            assertCreationReference(false);
            return await run(
              source,
              operation,
              (nativeIdentity) => {
                assertReferenceCurrent(nativeIdentity);
                assertCreationReference(false);
              },
              expectedIdentity,
              runOptions?.retireNativeOnFailure,
            );
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
            pending.delete(completion.promise);
            completion.resolve();
          }
        },
        release() {
          released = true;
          release ??= (async () => {
            await Promise.allSettled(pending);
            if (
              creatingTarget &&
              --creationBorrowers === 0 &&
              !fileIdentity &&
              !nativeClosing &&
              !cleanupFailure
            ) {
              if (generation) {
                // Source refusal can leave an unaccepted generation allocated before native open.
                try {
                  await closeNative(generation);
                } catch (error) {
                  reportCleanupFailure(error);
                }
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
            if (generation && !nativeClosing && !executionState.idle && !drainSignal.aborted) {
              executionState.idle = owner;
              const timer = runInExecutionOwnerContext(() =>
                setTimeout(() => {
                  if (idleTimer !== timer || executionState.idle !== owner) {
                    return;
                  }
                  void owner.closeIdle().catch(reportCleanupFailure);
                }, SQLITE_IDLE_HANDLE_TTL_MS),
              );
              idleTimer = timer;
              timer.unref();
              // Exit cannot join worker leases behind stalled non-storage cleanup.
              // Only idle generations retire here; accepted writers keep their custody.
              idleDrainListener = addAbortListener(drainSignal, () => {
                runInExecutionOwnerContext(() => {
                  void owner.closeIdle().catch(reportCleanupFailure);
                });
              });
              return;
            }
            try {
              await owner.closeIdle();
            } catch (error) {
              // The completed command stays acknowledged; the resource owner retains cleanup.
              reportCleanupFailure(error);
            }
          })();
          return release;
        },
      };
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
          revoke() {
            revoked = true;
            retired = true;
            clearIdleTimer();
          },
          close: () => owner.close(),
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
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (sharedIdentity) => {
        if (!sharedIdentity || sharedIdentity.key === context.admission.identity.key) {
          await owner.close();
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
