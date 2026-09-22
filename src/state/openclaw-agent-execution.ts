import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage } from "../infra/errors.js";
import { retainSqliteWorkerErrorCode } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { hasAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseRequestExecutionSource,
} from "./openclaw-agent-execution-contract.js";
import {
  createAgentDatabaseNativeGeneration,
  type AgentDatabaseExecutionScope,
  type AgentDatabaseNativeGeneration,
} from "./openclaw-agent-execution-native.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type OpenClawAgentDatabaseExecution = {
  readonly agentId: string;
  readonly path: string;
  assertCurrent(): void;
  /** Admit a write against existing storage; a missing store remains missing. */
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    options?: { retireNativeOnFailure: true },
  ): Promise<T | undefined>;
  /**
   * Join this reference's work; native cleanup failures remain with its resource owner.
   * The owner may retain one bounded idle generation.
   */
  release(): Promise<void>;
};

type ExecutionOwner = {
  readonly agentId: string;
  readonly sharedDatabaseKey: string;
  assertCurrent(): void;
  borrow(expectedIdentity?: AgentDatabaseExecutionFileIdentity): OpenClawAgentDatabaseExecution;
  closeIdle(): Promise<void>;
  close(): Promise<void>;
};

const log = createSubsystemLogger("state/agent-db");
// References are derived; the canonical agent and shared resource owners govern retirement.
const executionState = resolveGlobalSingleton<{
  owners: Map<string, ExecutionOwner>;
  // The slot stays occupied during eviction and after failed cleanup.
  idle?: ExecutionOwner;
}>(Symbol.for("openclaw.agentDatabaseExecutionOwners"), () => ({ owners: new Map() }));
const executions = executionState.owners;
const IDLE_EXECUTION_MS = 60_000;
const runInExecutionOwnerContext = AsyncLocalStorage.snapshot();

/** These native-only scopes still need their complete owning caller cutover. */
export function supportsOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    !isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) &&
    getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance !== true &&
    !hasAgentDatabaseMaintenanceAuthority() &&
    !getAgentDeletionDatabaseCleanup(options)
  );
}

/** Borrow before callers yield; native opening stays lazy and release joins owned work. */
export function captureOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: { expectedIdentity?: AgentDatabaseExecutionFileIdentity } = {},
): OpenClawAgentDatabaseExecution {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    throw new Error("This agent database scope still requires its existing native owner");
  }
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const existing = executions.get(pathname);
  if (existing) {
    if (existing.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${existing.agentId}; requested agent ${agentId}.`,
      );
    }
    if (existing.sharedDatabaseKey !== context.admission.identity.key) {
      throw new Error(
        "Agent database execution belongs to another shared-state database; drain its existing resources before changing the state directory.",
      );
    }
    return existing.borrow(constraints.expectedIdentity);
  }
  const executionOptions = { agentId, path: pathname, env: context.environment };
  let retired = false;
  let borrowers = 0;
  let generation: AgentDatabaseNativeGeneration | undefined;
  let fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  let nativeClosing: Promise<void> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  let unregisterShared: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = () => {
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
    executions.delete(pathname);
    unregisterAgent();
    unregisterShared?.();
  };

  const assertCurrent = () => {
    if (
      retired ||
      executions.get(pathname) !== owner ||
      !supportsOpenClawAgentDatabaseExecution(executionOptions)
    ) {
      throw new Error("Agent database execution admission is closed");
    }
    context.admission.assertCurrent();
    assertAgentDatabaseAdmitted(agentId, { env: context.environment });
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
    const result = captured.close().then(
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
    );
    nativeClosing = result;
    void result
      .finally(() => {
        if (nativeClosing === result) {
          nativeClosing = undefined;
        }
      })
      .catch(() => undefined);
    return result;
  };
  async function run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: () => void,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    retireNativeOnFailure = false,
  ): Promise<T | undefined> {
    assertCurrent();
    assertCallerCurrent?.();
    const pending = agentDatabaseLifecycle.pending.get(pathname);
    if (pending) {
      if (pending.agentId !== agentId) {
        throw new Error(`Agent database ${pathname} is opening for ${pending.agentId}`);
      }
      await pending.promise;
      pending.controller.signal.throwIfAborted();
      assertCurrent();
    }
    if (nativeClosing) {
      await nativeClosing;
      assertCurrent();
    }
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    if (!generation) {
      for (let idle = executionState.idle; idle && idle !== owner; idle = executionState.idle) {
        await idle.closeIdle();
        assertCurrent();
        source.assertCurrent();
        assertCallerCurrent?.();
      }
      if (!generation) {
        const created = createAgentDatabaseNativeGeneration(
          agentId,
          pathname,
          context,
          assertCurrent,
          () => {
            if (executions.get(pathname) !== owner || generation !== created || !nativeClosing) {
              throw new Error("Agent cleanup no longer owns its original execution reference");
            }
          },
          expectedIdentity ?? fileIdentity,
          (received) => {
            if (fileIdentity && fileIdentity.physicalIdentity !== received.physicalIdentity) {
              throw new Error("Agent database execution belongs to another physical file");
            }
            fileIdentity ??= Object.freeze({ ...received });
          },
        );
        generation = created;
      }
    }
    const current = generation;
    try {
      return await current.runExisting(source, operation, assertCallerCurrent);
    } catch (error) {
      const nativeFailed = current.failed();
      if (generation === current && (nativeFailed || retireNativeOnFailure)) {
        try {
          if (nativeFailed) {
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
      throw error;
    }
  }
  const owner: ExecutionOwner = {
    agentId,
    get sharedDatabaseKey() {
      return context.admission.identity.key;
    },
    assertCurrent,
    borrow(expected) {
      const expectedIdentity = expected ? Object.freeze({ ...expected }) : undefined;
      assertCurrent();
      if (expectedIdentity) {
        if (fileIdentity && fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity) {
          throw new Error("Agent database borrower belongs to another physical file");
        }
        assertExistingDatabaseIdentity(pathname, `file:${expectedIdentity.physicalIdentity}`);
      }
      observeOpenClawDatabaseMaintenanceResource(unregisterAgent);
      borrowers += 1;
      clearIdleTimer();
      if (executionState.idle === owner && !nativeClosing && !cleanupFailure) {
        executionState.idle = undefined;
      }
      let released = false;
      let release: Promise<void> | undefined;
      const pending = new Set<Promise<unknown>>();
      const assertReferenceCurrent = () => {
        assertCurrent();
        if (expectedIdentity) {
          if (fileIdentity && fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity) {
            throw new Error("Agent database borrower belongs to another physical file");
          }
          assertExistingDatabaseIdentity(pathname, `file:${expectedIdentity.physicalIdentity}`);
        }
      };
      const assertBorrowed = () => {
        if (released) {
          throw new Error("Agent database execution reference is released");
        }
        assertReferenceCurrent();
      };
      return {
        agentId,
        path: pathname,
        assertCurrent: assertBorrowed,
        async runExisting(source, operation, runOptions) {
          assertBorrowed();
          const result = run(
            source,
            operation,
            assertReferenceCurrent,
            expectedIdentity,
            runOptions?.retireNativeOnFailure,
          );
          pending.add(result);
          void result.finally(() => pending.delete(result)).catch(() => undefined);
          return result;
        },
        release() {
          released = true;
          release ??= (async () => {
            await Promise.allSettled(pending);
            borrowers -= 1;
            if (borrowers !== 0 || retired || cleanupFailure) {
              return;
            }
            if (generation && !nativeClosing && !executionState.idle) {
              executionState.idle = owner;
              const timer = runInExecutionOwnerContext(() =>
                setTimeout(() => {
                  if (idleTimer !== timer || executionState.idle !== owner) {
                    return;
                  }
                  void owner.closeIdle().catch(reportCleanupFailure);
                }, IDLE_EXECUTION_MS),
              );
              idleTimer = timer;
              timer.unref();
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
      if (cleanupFailure) {
        throw cleanupFailure.error;
      }
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
        throw error;
      });
      return closing;
    },
  };
  const unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
    agentId,
    path: pathname,
    revoke() {
      retired = true;
      clearIdleTimer();
    },
    close: () => owner.close(),
  });
  try {
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (!identity || identity.key === context.admission.identity.key) {
          await owner.close();
        }
      },
    });
  } catch (error) {
    unregisterAgent();
    throw error;
  }
  executions.set(pathname, owner);
  try {
    return owner.borrow(constraints.expectedIdentity);
  } catch (error) {
    executions.delete(pathname);
    unregisterAgent();
    unregisterShared?.();
    throw error;
  }
}
