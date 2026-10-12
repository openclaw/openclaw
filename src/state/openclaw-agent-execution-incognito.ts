import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IncognitoAcpSessionAccess } from "../acp/runtime/session-meta-incognito.types.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import { captureRuntimeConfigWithSource } from "../config/runtime-config-capture-state.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import {
  createIncognitoSessionFacts,
  type IncognitoSessionActor,
} from "../config/sessions/session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { forkIncognitoSessionFromParent } from "../config/sessions/session-incognito-lifecycle.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  isSqliteWorkerStoreAvailable,
  openEphemeralAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureAgentDatabaseAdmission } from "./agent-database-admission.js";
import { IncognitoSessionEndedError } from "./incognito-session-error.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  agentDatabaseLifecycle,
  retainIncognitoSharedState,
} from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseIncognitoAuthority,
  AgentDatabaseIncognitoIdentity,
  AgentDatabaseIncognitoOpen,
} from "./openclaw-agent-execution-contract.js";
import { createIncognitoAbsenceScopes } from "./openclaw-agent-execution-incognito-absence.js";
import type { IncognitoAgentDatabaseOperations } from "./openclaw-agent-execution-incognito-contract.js";
import {
  createIncognitoSessionActorFactory,
  invalidateIncognitoSessionActorTokens,
} from "./openclaw-agent-execution-incognito-session-actors.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

type Store = SqliteWorkerStore<IncognitoAgentDatabaseOperations>;
export type IncognitoAgentDatabaseExecution = IncognitoSessionActor & {
  readonly acp: IncognitoAcpSessionAccess;
  /** Explicit inactive-path acquisition; legacy callers retain their existing facts contract. */
  readonly sessionActors: ReturnType<typeof createIncognitoSessionActorFactory>;
  /** Release this borrow, without idle eviction of the memory database. */
  release(): Promise<void>;
  /** End the whole agent's incognito database, joining accepted work and native cleanup. */
  close(): Promise<void>;
};

export type IncognitoAgentExecutionOwner = {
  readonly kind: "ephemeral";
  readonly agentId: string;
  readonly identity: AgentDatabaseIncognitoIdentity;
  readonly facts: ReturnType<ReturnType<typeof createIncognitoSessionFacts>["captureRead"]>;
  assertCurrent(this: void): void;
  readonly state: "opening" | "live" | "closing" | "lost" | "closed";
  borrow(
    authority: AgentDatabaseIncognitoAuthority,
    signal?: AbortSignal,
  ): Promise<IncognitoAgentDatabaseExecution>;
  canRetryOpening(): boolean;
  close(): Promise<void>;
};

/** Lifetime implementation for the existing executor's namespace map, never a second registry. */
function createIncognitoAgentExecutionOwner(
  options: OpenClawAgentDatabaseOptions & { path: string },
  authority: AgentDatabaseIncognitoAuthority,
  lifecycle: { assertOwned(): void; retired(): void },
  signal?: AbortSignal,
): IncognitoAgentExecutionOwner {
  const context = captureOpenClawStateReadWorkerContext({ env: options.env });
  const assertAgent = captureAgentDatabaseAdmission(options.agentId, { env: context.environment });
  const identity: AgentDatabaseIncognitoIdentity = Object.freeze({
    kind: "ephemeral",
    handle: randomUUID(),
    incarnation: randomUUID(),
  });
  const input: AgentDatabaseIncognitoOpen = {
    kind: "ephemeral",
    identity,
    agentId: options.agentId,
    databasePath: options.path,
    environment: context.environment,
  };
  let state: IncognitoAgentExecutionOwner["state"] = "opening";
  let published = false;
  let pendingBorrows = 0;
  let loss: IncognitoSessionEndedError | undefined;
  let store: Store | undefined;
  let opening: Promise<Store> | undefined;
  let openingFailed = false;
  let closing: Promise<void> | undefined;
  let nativeStopped: Promise<void> | undefined;
  let unregisterShared: (() => void) | undefined;
  let releaseShared: (() => void) | undefined;
  const actorWriteTokens = new Map<
    string,
    { writeToken: string; dependencySessionIds: string[] }
  >();
  const sessionActors = new Set<SessionActor>();
  const pending = new Set<Promise<unknown>>();
  const continuations = new AsyncLocalStorage<{ borrow: object; active: boolean }>();
  const assertRetainedCurrent = () => {
    if (loss || state === "closed") {
      throw loss ?? new IncognitoSessionEndedError();
    }
    lifecycle.assertOwned();
    context.admission.assertCurrent();
    assertAgent();
    if (
      agentDatabaseLifecycle.databases.has(options.path) ||
      agentDatabaseLifecycle.pending.has(options.path)
    ) {
      throw new Error("Incognito namespace already belongs to the native owner");
    }
    if (store && !isSqliteWorkerStoreAvailable(store)) {
      throw new IncognitoSessionEndedError();
    }
  };
  const assertCurrent = () => {
    if (state === "closing") {
      throw new IncognitoSessionEndedError();
    }
    assertRetainedCurrent();
  };
  const sessionFacts = createIncognitoSessionFacts(
    identity,
    assertRetainedCurrent,
    (targets) => invalidateIncognitoSessionActorTokens(actorWriteTokens, targets),
    assertCurrent,
  );
  const admission =
    (source: AgentDatabaseIncognitoAuthority): SqliteWorkerAdmissionFactory =>
    () => ({
      nativeLocations: [],
      admission: createSqliteWorkerOperationAdmission((_request, grant) => {
        source.assertCurrent();
        assertRetainedCurrent();
        // Session commands use their separate request-bound transaction/commit admission.
        if (!grant()) {
          throw new Error("Incognito actor admission was refused");
        }
      }),
    });
  const track = <T>(work: Promise<T>, collection = pending): Promise<T> => {
    collection.add(work);
    void work.finally(() => collection.delete(work)).catch(() => undefined);
    return work;
  };
  const drain = async (collection: Set<Promise<unknown>>) => {
    while (collection.size > 0) {
      await Promise.allSettled(collection);
    }
  };
  const open = (): Promise<Store> => {
    opening ??= Promise.resolve()
      .then(async () => {
        authority.assertCurrent();
        assertCurrent();
        signal?.throwIfAborted();
        assertIncognitoAgentDatabasePathAvailable(options.path);
        const opened =
          await openEphemeralAgentDatabaseSqliteWorkerStore<IncognitoAgentDatabaseOperations>(
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
              databasePath: options.path,
              target: identity,
              input,
            },
            {
              assertCurrent() {
                authority.assertCurrent();
                assertCurrent();
                signal?.throwIfAborted();
              },
              createAdmission: admission(authority),
              signal,
              onNativeLost(error) {
                loss ??= new IncognitoSessionEndedError({ cause: error });
                state = "lost";
                sessionFacts.clear();
              },
              onNativeStopped(stopped) {
                nativeStopped = stopped;
              },
            },
          );
        if (!opened) {
          throw new Error("Incognito actor was not created");
        }
        store = opened;
        authority.assertCurrent();
        assertCurrent();
        signal?.throwIfAborted();
        return opened;
      })
      .catch((error: unknown) => {
        openingFailed = true;
        throw error;
      });
    return opening;
  };
  const owner: IncognitoAgentExecutionOwner = {
    kind: "ephemeral",
    agentId: options.agentId,
    identity,
    facts: sessionFacts.captureRead(assertCurrent),
    assertCurrent,
    get state() {
      return state;
    },
    canRetryOpening() {
      if (!openingFailed || state !== "closed") {
        return false;
      }
      let sourceRefused = signal?.aborted === true;
      if (!sourceRefused) {
        try {
          authority.assertCurrent();
        } catch {
          sourceRefused = true;
        }
      }
      if (!sourceRefused) {
        return false;
      }
      context.admission.assertCurrent();
      assertAgent();
      return true;
    },
    async borrow(source, borrowSignal) {
      pendingBorrows += 1;
      let opened: Store;
      try {
        source.assertCurrent();
        borrowSignal?.throwIfAborted();
        opened = await open();
        source.assertCurrent();
        assertCurrent();
        borrowSignal?.throwIfAborted();
      } catch (error) {
        pendingBorrows -= 1;
        if (!published && (openingFailed || pendingBorrows === 0)) {
          try {
            await owner.close();
          } catch (cleanupError) {
            throw createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "Incognito admission and cleanup failed",
              error,
            );
          }
        }
        throw error;
      }
      pendingBorrows -= 1;
      published = true;
      state = "live";
      let released = false;
      let releasing: Promise<void> | undefined;
      const borrowedWork = new Set<Promise<unknown>>();
      const acquiredActors = new Set<SessionActor>();
      const borrow = {};
      const assertReferenceCurrent = () => {
        assertCurrent();
        source.assertCurrent();
        if (released) {
          throw new Error("Incognito execution reference is released");
        }
      };
      const assertBorrowed = () => {
        const current = continuations.getStore();
        if (current?.borrow === borrow && current.active) {
          assertRetainedCurrent();
          source.assertCurrent();
        } else {
          assertReferenceCurrent();
        }
      };
      const retain = <T>(
        operation: () => Promise<T>,
        kind: "composition" | "command" | "cleanup" | "settlement" = "composition",
      ): Promise<T> => {
        const parent = continuations.getStore();
        const continuation = { borrow, active: true };
        const completion = createDeferredCore<T>();
        const work = track(track(completion.promise), borrowedWork);
        const execute = () =>
          continuations.run(continuation, async () => {
            try {
              const result = await operation();
              // Nested work may feed its still-live composition, never a released caller.
              if (
                kind === "cleanup" ||
                kind === "settlement" ||
                (parent?.borrow === borrow && parent.active)
              ) {
                assertRetainedCurrent();
              } else if (kind === "command") {
                assertCurrent();
              } else {
                assertReferenceCurrent();
              }
              return result;
            } finally {
              continuation.active = false;
            }
          });
        // Commands reserve FIFO now; deferred compositions retain custody before their callback runs.
        const running = kind === "composition" ? Promise.resolve().then(execute) : execute();
        void running.then(completion.resolve, completion.reject);
        return work;
      };
      const run = <T>(
        currentAuthority: IncognitoSessionAuthority,
        operation: (scope: Pick<Store, "execute">) => Promise<T>,
        operationSignal?: AbortSignal,
        createAdmission?: SqliteWorkerAdmissionFactory,
        cleanup = false,
      ): Promise<T> => {
        currentAuthority.assertCurrent();
        if (cleanup) {
          assertRetainedCurrent();
        } else {
          assertBorrowed();
        }
        const assertOperation = () => {
          if (!cleanup) {
            source.assertCurrent();
          }
          currentAuthority.assertCurrent();
          assertRetainedCurrent();
          operationSignal?.throwIfAborted();
        };
        return retain(
          () =>
            runOpenClawAgentWorkerWrite(
              { target: identity, assertCurrent: assertOperation },
              async () => {
                try {
                  const result = await runSqliteWorkerStoreOperation(
                    opened,
                    operation,
                    undefined,
                    assertOperation,
                    createAdmission ?? admission({ assertCurrent: assertOperation }),
                  );
                  assertOperation();
                  return result;
                } catch (error) {
                  if (loss || !isSqliteWorkerStoreAvailable(opened)) {
                    // The broker settles dispatched custody only after native worker exit.
                    await nativeStopped;
                    throw loss ?? new IncognitoSessionEndedError({ cause: error });
                  }
                  throw error;
                }
              },
              undefined,
              operationSignal,
            ),
          cleanup ? "cleanup" : "command",
        );
      };
      const execution: IncognitoAgentDatabaseExecution = {
        agentId: options.agentId,
        path: options.path,
        identity,
        sessions: sessionFacts.bind(run, assertBorrowed, retain, () => source.assertCurrent()),
        sessionActors: createIncognitoSessionActorFactory({
          options,
          identity,
          assertBorrowed,
          assertReferenceCurrent,
          assertRetainedCurrent,
          retain: (operation) => retain(operation, "settlement"),
          run: (actorAuthority, operation, actorAdmission) =>
            run(actorAuthority, operation, undefined, actorAdmission, false),
          writeTokens: actorWriteTokens,
          sessionFacts,
          sessionActors,
          acquiredActors,
          getExecution: () => execution,
        }),
        acp: {
          prepareEntryRead(params) {
            const readAuthority = params.authority;
            const env = cloneEnvWithPlatformSemantics(params.env);
            env.OPENCLAW_STATE_DIR = resolveStateDir(env);
            const shared = captureOpenClawStateReadWorkerContext({
              env,
              path: params.databasePath ? path.resolve(params.databasePath) : undefined,
            });
            const readInput = {
              signal: params.signal,
              cfg: captureRuntimeConfigWithSource(params.cfg, params.cfg),
              sessionKey: params.sessionKey,
              env,
              databasePath: shared.admission.databasePath,
              storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
                agentId: execution.agentId,
                env,
              }),
            };
            const assertReadCurrent = () => {
              execution.assertCurrent();
              readAuthority.assertCurrent();
              shared.maintenanceScope?.assertAdmission();
              shared.admission.assertCurrent();
            };
            assertReadCurrent();
            return execution.sessions.withSharedState(async () => {
              const { prepareIncognitoAcpSessionEntryRead } =
                await import("../acp/runtime/session-meta-worker-mutation.js");
              readInput.signal?.throwIfAborted();
              assertReadCurrent();
              return prepareIncognitoAcpSessionEntryRead({
                ...readInput,
                actor: execution,
                authority: {
                  assertCurrent: assertReadCurrent,
                  authorize: (stage, facts) => readAuthority.authorize?.(stage, facts),
                },
              });
            });
          },
          readEntry(params) {
            return execution.sessions
              .withSharedState(async () => {
                const { readIncognitoAcpSessionEntry } =
                  await import("../acp/runtime/session-meta-worker-mutation.js");
                return readIncognitoAcpSessionEntry({ ...params, actor: execution });
              })
              .then((entry) => {
                params.authority.assertCurrent();
                execution.assertReadable();
                return entry;
              });
          },
          upsertMeta(params) {
            return execution.sessions
              .withSharedState(async () => {
                const { upsertIncognitoAcpSessionMeta } =
                  await import("../acp/runtime/session-meta-worker-mutation.js");
                return upsertIncognitoAcpSessionMeta({ ...params, actor: execution });
              })
              .then((entry) => {
                params.authority.assertCurrent();
                execution.assertReadable();
                return entry;
              });
          },
        },
        assertCurrent: assertBorrowed,
        assertReadable: assertReferenceCurrent,
        release() {
          released = true;
          releasing ??= (async () => {
            await drain(borrowedWork);
            await Promise.all([...acquiredActors].map((actor) => actor.release()));
          })();
          return releasing;
        },
        close: () => owner.close(),
      };
      return execution;
    },
    close() {
      if (state === "closed") {
        return Promise.resolve();
      }
      if (!loss) {
        state = "closing";
      }
      closing ??= (async () => {
        await drain(pending);
        await opening?.catch(() => undefined);
        await Promise.all([...sessionActors].map((actor) => actor.release()));
        // Accepted compositions own their cleanup and commit facts until they settle.
        sessionFacts.clear();
        await store?.close();
        await nativeStopped;
        continuations.disable();
        state = "closed";
        unregister();
        unregisterShared?.();
        releaseShared?.();
        lifecycle.retired();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource({
    agentId: options.agentId,
    path: options.path,
    revoke() {
      if (!loss) {
        state = "closing";
      }
    },
    close: () => owner.close(),
  });
  try {
    releaseShared = retainIncognitoSharedState(context.environment);
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (sharedIdentity) => {
        if (!sharedIdentity || sharedIdentity.key === context.admission.identity.key) {
          await owner.close();
        }
      },
    });
  } catch (error) {
    continuations.disable();
    releaseShared?.();
    unregister();
    throw error;
  }
  return owner;
}

/** Bind ephemeral lifetime to the canonical execution owner map, without a parallel registry. */
export function createAgentDatabaseExecutionCapture<FileExecution, FileConstraints>(
  executions: {
    get(pathname: string): IncognitoAgentExecutionOwner | { kind: "file" } | undefined;
    set(pathname: string, owner: IncognitoAgentExecutionOwner): void;
    delete(pathname: string): void;
    entries(): MapIterator<[string, IncognitoAgentExecutionOwner | { kind: "file" }]>;
  },
  captureFile: (
    options: OpenClawAgentDatabaseOptions,
    constraints?: FileConstraints,
  ) => FileExecution,
) {
  const absentSources = createIncognitoAbsenceScopes(
    (pathname) => executions.get(pathname) !== undefined,
  );
  /** Inactive actor entry point. Production incognito routing stays native until P7. */
  async function openIncognitoAgentDatabaseExecution(
    options: Omit<OpenClawAgentDatabaseOptions, "path">,
    authority: AgentDatabaseIncognitoAuthority,
    request: { existingOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<IncognitoAgentDatabaseExecution | undefined> {
    authority.assertCurrent();
    const { existingOnly, signal } = request;
    signal?.throwIfAborted();
    const capturedOptions = {
      ...options,
      env: {
        ...(options.env ?? process.env),
        OPENCLAW_STATE_DIR: resolveStateDir(options.env ?? process.env),
      },
    };
    const agentId = normalizeAgentId(capturedOptions.agentId);
    const pathname = resolveIncognitoOpenClawAgentSqlitePath({ ...capturedOptions, agentId });
    let owner = executions.get(pathname);
    if (owner && owner.kind !== "ephemeral") {
      throw new Error("Incognito namespace belongs to a file execution owner");
    }
    if (existingOnly && (!owner || owner.state === "opening")) {
      return undefined;
    }
    if (owner && (owner.state === "lost" || owner.state === "closed") && !existingOnly) {
      await owner.close();
      authority.assertCurrent();
      signal?.throwIfAborted();
      return openIncognitoAgentDatabaseExecution(capturedOptions, authority, {
        existingOnly,
        signal,
      });
    }
    const joinedOpening = owner?.state === "opening";
    if (!owner) {
      const created = createIncognitoAgentExecutionOwner(
        { ...capturedOptions, agentId, path: pathname },
        authority,
        {
          assertOwned() {
            if (executions.get(pathname) !== created) {
              throw new Error("Incognito execution no longer owns its namespace");
            }
          },
          retired() {
            if (executions.get(pathname) === created) {
              executions.delete(pathname);
            }
          },
        },
        signal,
      );
      absentSources.revoke(pathname);
      executions.set(pathname, created);
      owner = created;
    }
    try {
      return await owner.borrow(authority, signal);
    } catch (error) {
      if (!joinedOpening) {
        throw error;
      }
      authority.assertCurrent();
      signal?.throwIfAborted();
      if (!owner.canRetryOpening()) {
        throw error;
      }
      return openIncognitoAgentDatabaseExecution(capturedOptions, authority, request);
    }
  }

  type EphemeralTarget = {
    kind: "ephemeral";
    agentId: string;
    env?: NodeJS.ProcessEnv;
    authority: AgentDatabaseIncognitoAuthority;
    existingOnly?: boolean;
    signal?: AbortSignal;
  };
  function capture(target: EphemeralTarget): Promise<IncognitoAgentDatabaseExecution | undefined>;
  function capture(
    options: OpenClawAgentDatabaseOptions,
    constraints?: FileConstraints,
  ): FileExecution;
  function capture(
    target: (OpenClawAgentDatabaseOptions & { kind?: "file" }) | EphemeralTarget,
    constraints?: FileConstraints,
  ): FileExecution | Promise<IncognitoAgentDatabaseExecution | undefined> {
    if (target.kind === "ephemeral") {
      return openIncognitoAgentDatabaseExecution(
        { agentId: target.agentId, env: target.env },
        target.authority,
        { existingOnly: target.existingOnly, signal: target.signal },
      );
    }
    return captureFile(target, constraints);
  }
  return Object.assign(capture, {
    forkIncognitoSessionFromParent,
    captureIncognitoAbsence: absentSources.capture,
    /** Inactive topology view; production discovery continues to use the native owner. */
    listIncognito(env: NodeJS.ProcessEnv = process.env) {
      const capturedEnv = { ...env, OPENCLAW_STATE_DIR: resolveStateDir(env) };
      return [...executions.entries()].flatMap(([pathname, owner]) => {
        if (
          owner.kind !== "ephemeral" ||
          owner.state !== "live" ||
          pathname !==
            resolveIncognitoOpenClawAgentSqlitePath({ agentId: owner.agentId, env: capturedEnv })
        ) {
          return [];
        }
        owner.assertCurrent();
        return [
          {
            agentId: owner.agentId,
            storePath: pathname,
            identity: owner.identity,
            facts: owner.facts,
            assertCurrent: owner.assertCurrent,
          },
        ];
      });
    },
  });
}
