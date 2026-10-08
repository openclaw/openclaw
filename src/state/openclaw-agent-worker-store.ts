import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import {
  assertExistingDatabaseIdentity,
  normalizeDatabasePath,
} from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  reserveSqliteWorkerInputPreparation,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getGatewayRestartDrainSignal,
  getGatewayShutdownCleanupSignal,
} from "../process/gateway-work-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseExecutionScope,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/agent-db");

function reportCompletedPublicationCleanupFailure(error: unknown): void {
  try {
    log.warn(`Agent publication completed before cleanup failed: ${formatErrorMessage(error)}`);
  } catch {
    // Diagnostics cannot turn a completed publication into a replayable failure.
  }
}

export type OpenClawAgentSqliteWorkerStore<Operations extends SqliteWorkerOperations> = {
  execute<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    assertCurrent: () => void,
    options?: { signal?: AbortSignal },
  ): Promise<Operations[Key]["output"]>;
  /** Absence has no receipt; a present command can legitimately return undefined. */
  executeExisting<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    assertCurrent: () => void,
    options?: { signal?: AbortSignal },
  ): Promise<{ value: Operations[Key]["output"] } | undefined>;
  run<T>(
    operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T>;
  close(): Promise<void>;
};

/** Send a paired module's command through the caller's already-admitted executor. */
export function executeOpenClawAgentWorkerPublication<
  Operations extends SqliteWorkerOperations,
  Key extends keyof Operations,
>(
  scope: AgentDatabaseExecutionScope,
  publication: {
    id: string;
    moduleUrl: string;
    input: unknown;
    command: { type: Key; input: Operations[Key]["input"] };
  },
  options?: { signal?: AbortSignal },
): Promise<Operations[Key]["output"]> {
  const { command } = publication;
  if (typeof command.type !== "string") {
    throw new Error("Agent publication commands require a string type");
  }
  const result = scope.execute(
    {
      type: "database.domain.publish",
      input: { ...publication, command: { type: command.type, input: command.input } },
    },
    options,
  );
  // SAFETY: The paired static module owns this serialized command/result contract.
  return result as Promise<Operations[Key]["output"]>;
}

/** Retains a native borrow or checks a caller-held executor; each operation borrows the canonical executor. */
export async function openOpenClawAgentSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  inputOptions: OpenClawAgentDatabaseOptions,
  publicationSource: DatabaseSync | { execution: OpenClawAgentDatabaseExecution },
  worker: {
    moduleUrl: URL;
    input: unknown;
    assertAdmission?: (request: SqliteWorkerAdmissionRequest) => SqliteWorkerAdmissionRequest;
    /** Only for an accepted sequence whose owner closes this store at settlement. */
    retainExecutionUntilClose?: true;
  },
): Promise<OpenClawAgentSqliteWorkerStore<Operations>> {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    ...inputOptions,
    agentId: normalizeAgentId(inputOptions.agentId),
    env,
    path: resolveOpenClawAgentSqlitePath({ ...inputOptions, env }),
  };
  const capturedExecution =
    "execution" in publicationSource ? publicationSource.execution : undefined;
  const expectedDatabase = "execution" in publicationSource ? undefined : publicationSource;
  if (
    capturedExecution &&
    (capturedExecution.agentId !== options.agentId || capturedExecution.path !== options.path)
  ) {
    throw new Error("Agent publication source differs from its captured executor");
  }
  const prepared = expectedDatabase
    ? readOpenClawAgentDatabaseIdentity({ db: expectedDatabase })
    : undefined;
  if (prepared && typeof prepared.identity !== "string") {
    throw new Error("Agent Worker requires its existing file owner");
  }
  const expectedIdentity =
    prepared && typeof prepared.identity === "string"
      ? {
          kind: "file" as const,
          physicalIdentity: prepared.identity,
          nativeLocation: prepared.filename,
          birthtime: prepared.birthtime,
        }
      : undefined;
  const moduleUrl = new URL(worker.moduleUrl).href;
  const input = structuredClone(worker.input);
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(options.env),
  );
  let revoked = false;
  let closing: Promise<void> | undefined;
  let drainExecution: OpenClawAgentDatabaseExecution | undefined;
  let retainedExecution: OpenClawAgentDatabaseExecution | undefined;
  let releaseBorrow: (() => void) | undefined;
  let unregisterAgent: (() => void) | undefined;
  let unregisterState: (() => void) | undefined;
  const pending = new Set<Promise<unknown>>();
  const cleanupSignal = getGatewayShutdownCleanupSignal();
  const releaseDrainExecution = async () => {
    await drainExecution?.release();
    drainExecution = undefined;
  };
  const assertHeld = (cleanup = false) => {
    if (revoked && !cleanup) {
      throw new AgentDatabaseExecutionAdmissionClosedError("Agent database Worker owner is closed");
    }
    state.assertCurrent();
    if (capturedExecution) {
      capturedExecution.assertCurrent();
      return;
    }
    const current = getOpenClawAgentDatabaseIfOpen(options);
    if (
      !expectedDatabase ||
      !current ||
      current.db !== expectedDatabase ||
      !expectedDatabase.isOpen ||
      normalizeDatabasePath(expectedDatabase.location() ?? "") !== prepared?.filename
    ) {
      throw new Error("Borrowed agent database closed or changed before Worker admission");
    }
  };
  assertHeld();
  if (expectedIdentity) {
    assertExistingDatabaseIdentity(
      options.path,
      `file:${expectedIdentity.physicalIdentity}`,
      expectedIdentity.birthtime,
    );
  }
  const close = (): Promise<void> => {
    revoked = true;
    cleanupListener[Symbol.dispose]();
    closing ??= (async () => {
      await Promise.allSettled(pending);
      await releaseDrainExecution();
      await retainedExecution?.release();
      retainedExecution = undefined;
      releaseBorrow?.();
      releaseBorrow = undefined;
      unregisterAgent?.();
      unregisterState?.();
    })().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const cleanupListener = addAbortListener(cleanupSignal, () => {
    const release = releaseDrainExecution();
    pending.add(release);
    void release
      .finally(() => pending.delete(release))
      .catch(reportCompletedPublicationCleanupFailure);
  });
  try {
    unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
      agentId: options.agentId,
      path: options.path,
      revoke: () => {
        revoked = true;
      },
      close,
    });
    unregisterState = registerOpenClawStateDatabaseAsyncResource({
      close: async (closedIdentity) => {
        if (!closedIdentity || closedIdentity.key === state.identity.key) {
          await close();
        }
      },
    });
    if (expectedDatabase) {
      releaseBorrow = retainAgentDatabase(expectedDatabase);
    }
    if (worker.retainExecutionUntilClose) {
      // A lifetime borrow leaves native opening lazy and each command in its own FIFO turn.
      retainedExecution = captureOpenClawAgentDatabaseExecution(options, { expectedIdentity });
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Agent publication setup and cleanup failed",
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }
  const runPublication = <T>(
    assertCurrent: () => void,
    operation: (
      execution: OpenClawAgentDatabaseExecution,
      source: AgentDatabaseRequestExecutionSource,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (revoked) {
      return Promise.reject(
        new AgentDatabaseExecutionAdmissionClosedError("Agent database Worker owner is closed"),
      );
    }
    const assert = () => {
      assertHeld();
      assertCurrent();
      assertHeld();
    };
    const execution = captureOpenClawAgentDatabaseExecution(options, { expectedIdentity });
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: assert,
      createAdmission(binding) {
        return () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          return {
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(worker.assertAdmission?.(request) ?? request);
              if (request.stage === "transaction" || request.stage === "commit") {
                if (
                  !(
                    (phase === "waiting" && request.stage === "transaction") ||
                    (phase === "transaction" && request.stage === "commit")
                  )
                ) {
                  throw new Error("Agent publication authority requested out of order");
                }
                phase = request.stage;
              }
              if (!grant()) {
                throw new Error("Agent publication authority expired");
              }
            }, binding.attachment),
          };
        };
      },
    };
    const result = (async () => {
      let completed: Result<T, unknown>;
      try {
        const publicationValue = await runOpenClawAgentWorkerWrite(
          options,
          () => operation(execution, source),
          undefined,
          signal,
        );
        completed = { ok: true, value: publicationValue };
      } catch (error) {
        completed = { ok: false, error };
      }
      let releasing: OpenClawAgentDatabaseExecution | undefined = execution;
      if (
        completed.ok &&
        !revoked &&
        !retainedExecution &&
        getGatewayRestartDrainSignal().aborted &&
        !cleanupSignal.aborted
      ) {
        // Keep one lease during grace; cleanup releases retention independently of the marker.
        const previous = drainExecution;
        drainExecution = execution;
        releasing = previous;
      }
      try {
        await releasing?.release();
      } catch (releaseError) {
        if (!completed.ok) {
          throw createSqliteLifecycleAggregateError(
            [completed.error, releaseError],
            "Agent publication and executor release failed",
            completed.error,
          );
        }
        reportCompletedPublicationCleanupFailure(releaseError);
      }
      if (!completed.ok) {
        throw completed.error;
      }
      return completed.value;
    })();
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  };
  const executeCommand = async <Key extends keyof Operations, Output>(
    command: { type: Key; input: Operations[Key]["input"] },
    assertCurrent: () => void,
    select: (receipt: { value: Operations[Key]["output"] } | undefined) => Output,
    commandOptions?: { signal?: AbortSignal },
  ): Promise<Output> => {
    commandOptions?.signal?.throwIfAborted();
    if (typeof command.type !== "string") {
      throw new Error("Agent publication commands require a string type");
    }
    const publication = {
      id: randomUUID(),
      moduleUrl,
      input,
      command: { type: command.type, input: command.input },
    };
    const captured = serialize(publication);
    const preparation = reserveSqliteWorkerInputPreparation(captured.byteLength, "snapshot");
    try {
      return await runPublication(
        assertCurrent,
        async (execution, source) => {
          const receipt = await execution.runExisting(source, async (scope) => ({
            value: await preparation.handoff(() =>
              executeOpenClawAgentWorkerPublication<Operations, Key>(
                scope,
                // SAFETY: These private bytes snapshot this method's typed publication above.
                deserialize(captured) as typeof publication,
                commandOptions,
              ),
            ),
          }));
          return select(receipt);
        },
        commandOptions?.signal,
      );
    } finally {
      preparation.release();
    }
  };
  return {
    execute(command, assertCurrent, commandOptions) {
      return executeCommand(
        command,
        assertCurrent,
        (receipt) => {
          if (!receipt) {
            throw new Error("Agent database disappeared before publication");
          }
          return receipt.value;
        },
        commandOptions,
      );
    },
    executeExisting(command, assertCurrent, commandOptions) {
      return executeCommand(command, assertCurrent, (receipt) => receipt, commandOptions);
    },
    run<T>(
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
      assertCurrent: () => void,
    ): Promise<T> {
      return runPublication(assertCurrent, async (execution, source) => {
        const cleanupSource: AgentDatabaseRequestExecutionSource = {
          assertCurrent: () => assertHeld(true),
          createAdmission(binding) {
            return () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                if (request.stage !== "prepare") {
                  throw new Error("Publication cleanup cannot open storage or admit a transaction");
                }
                binding.authorize(request);
                if (!grant()) {
                  throw new Error("Agent publication cleanup authority expired");
                }
              }, binding.attachment),
            });
          },
        };
        const id = randomUUID();
        let bound = false;
        const failures: unknown[] = [];
        let outcome: Result<T, unknown>;
        try {
          const executed = await execution.runExisting(source, async (scope) => {
            await scope.execute({
              type: "database.domain.bind",
              input: { id, moduleUrl, input },
            });
            bound = true;
            let accepting = true;
            const commands = new Set<Promise<unknown>>();
            const commandFailures: unknown[] = [];
            let callback: Result<T, unknown>;
            try {
              const callbackValue = await operation({
                execute: (command, commandOptions) => {
                  if (!accepting) {
                    return Promise.reject(new Error("Agent publication operation is closed"));
                  }
                  if (typeof command.type !== "string") {
                    return Promise.reject(
                      new Error("Agent publication commands require a string type"),
                    );
                  }
                  const commandResult = scope.execute(
                    {
                      type: "database.domain.execute",
                      input: { id, command: { type: command.type, input: command.input } },
                    },
                    commandOptions,
                  );
                  commands.add(commandResult);
                  void commandResult.then(
                    () => commands.delete(commandResult),
                    (error: unknown) => {
                      if (!commandFailures.includes(error)) {
                        commandFailures.push(error);
                      }
                      commands.delete(commandResult);
                    },
                  );
                  // SAFETY: The paired static module owns this serialized command/result contract.
                  return commandResult as Promise<Operations[typeof command.type]["output"]>;
                },
              });
              callback = { ok: true, value: callbackValue };
            } catch (error) {
              callback = { ok: false, error };
            }
            accepting = false;
            await Promise.allSettled(commands);
            if (!callback.ok) {
              failures.push(callback.error);
            }
            for (const error of commandFailures) {
              if (!failures.includes(error)) {
                failures.push(error);
              }
            }
            if (!callback.ok) {
              throw callback.error;
            }
            return { value: callback.value };
          });
          outcome = executed
            ? { ok: true, value: executed.value }
            : { ok: false, error: new Error("Agent database disappeared before publication") };
        } catch (error) {
          outcome = { ok: false, error };
        }
        if (!outcome.ok && !failures.includes(outcome.error)) {
          failures.push(outcome.error);
        }
        if (bound) {
          try {
            // This fresh scope exposes only exact-binding TEMP cleanup, never durable work.
            await execution.runExisting(
              cleanupSource,
              (scope) => scope.execute({ type: "database.domain.close", input: { id } }),
              { retireNativeOnFailure: true },
            );
          } catch (error) {
            if (error instanceof AgentDatabaseExecutionAdmissionClosedError) {
              // Refused cleanup retired its captured native generation, including TEMP bindings.
            } else if (outcome.ok && failures.length === 0) {
              reportCompletedPublicationCleanupFailure(error);
            } else {
              failures.push(error);
            }
          }
        }
        throwSqliteLifecycleErrors(failures, "Agent publication and cleanup failed");
        if (!outcome.ok) {
          throw outcome.error;
        }
        return outcome.value;
      });
    },
    close,
  };
}
