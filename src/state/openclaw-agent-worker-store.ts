import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  readOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "./openclaw-agent-db-identity.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
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
  run<T>(
    operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T>;
  close(): Promise<void>;
};

/** A publication client retains its host borrow; each operation borrows the canonical executor. */
export async function openOpenClawAgentSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  inputOptions: OpenClawAgentDatabaseOptions,
  expectedDatabase: DatabaseSync,
  worker: { moduleUrl: URL; input: unknown },
): Promise<OpenClawAgentSqliteWorkerStore<Operations>> {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    ...inputOptions,
    env,
    path: resolveOpenClawAgentSqlitePath({ ...inputOptions, env }),
  };
  const prepared = readOpenClawAgentDatabaseIdentity({ db: expectedDatabase });
  if (typeof prepared.identity !== "string") {
    throw new Error("Agent Worker requires its existing file owner");
  }
  const identity = `file:${prepared.identity}`;
  const expectedIdentity = {
    kind: "file" as const,
    physicalIdentity: prepared.identity,
    nativeLocation: prepared.filename,
  };
  const moduleUrl = new URL(worker.moduleUrl).href;
  const input = structuredClone(worker.input);
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(options.env),
  );
  let revoked = false;
  let closing: Promise<void> | undefined;
  let releaseBorrow: (() => void) | undefined;
  let unregisterAgent: (() => void) | undefined;
  let unregisterState: (() => void) | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertHeld = (cleanup = false) => {
    if (revoked && !cleanup) {
      throw new Error("Agent database Worker owner is closed");
    }
    state.assertCurrent();
    const current = getOpenClawAgentDatabaseIfOpen(options);
    if (
      !current ||
      current.db !== expectedDatabase ||
      !expectedDatabase.isOpen ||
      !isOpenClawAgentDatabasePathCurrent(current)
    ) {
      throw new Error("Borrowed agent database closed or changed before Worker admission");
    }
    assertExistingDatabaseIdentity(options.path, identity);
  };
  assertHeld();
  const close = (): Promise<void> => {
    revoked = true;
    closing ??= (async () => {
      await Promise.allSettled(pending);
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
    releaseBorrow = retainAgentDatabase(expectedDatabase);
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
  return {
    run<T>(
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
      assertCurrent: () => void,
    ): Promise<T> {
      if (revoked) {
        return Promise.reject(new Error("Agent database Worker owner is closed"));
      }
      const assert = () => {
        assertHeld();
        assertCurrent();
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
                binding.authorize(request);
                assert();
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
              }),
            };
          };
        },
      };
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
              assertHeld(true);
              if (!grant()) {
                throw new Error("Agent publication cleanup authority expired");
              }
            }),
          });
        },
      };
      const result = (async () => {
        let completed: Result<T, unknown>;
        try {
          const publicationValue = await runOpenClawAgentWorkerWrite(options, async () => {
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
                if (outcome.ok && failures.length === 0) {
                  reportCompletedPublicationCleanupFailure(error);
                } else {
                  failures.push(error);
                }
              }
            }
            if (failures.length === 1) {
              throw failures[0];
            }
            if (failures.length > 1) {
              throw createSqliteLifecycleAggregateError(
                failures,
                "Agent publication and cleanup failed",
                failures[0],
              );
            }
            if (!outcome.ok) {
              throw outcome.error;
            }
            return outcome.value;
          });
          completed = { ok: true, value: publicationValue };
        } catch (error) {
          completed = { ok: false, error };
        }
        try {
          await execution.release();
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
    },
    close,
  };
}
