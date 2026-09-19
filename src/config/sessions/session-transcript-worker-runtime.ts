import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerDatabase,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
  type UsageCostWorkerResult,
} from "../../infra/session-cost-usage-worker.types.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions, WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntryReadOnlyInScope } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import {
  sessionHistoryCleanupError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import { listSessionMembers } from "./session-sharing-store.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type {
  SessionTranscriptHistoryWorkerInput,
  SessionRowPresenceWorkerInput,
  SessionMembersWorkerInput,
  SessionUsageCacheWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const historyPages = new WorkerTaskPool<
  | SessionTranscriptHistoryWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionMembersWorkerInput
  | SessionUsageCacheWorkerInput,
  SessionTranscriptWorkerReply<
    "history-page" | "session-row-presence" | "session-members" | "usage-cache"
  >
>({
  workerUrl,
  maxWorkers: 1,
  idleTimeoutMs: 0,
  prepareWorker: () => {
    ensureSqliteLibrarySelected();
    return { options: {} };
  },
});

function createUsageCostPool(kind: "read" | "refresh") {
  return new WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>({
    workerUrl,
    maxWorkers: 1,
    // Foreground reads must remain available while refresh awaits a host writer.
    sharedCompute: kind === "refresh",
    idleTimeoutMs: 0,
    prepareWorker: () => {
      ensureSqliteLibrarySelected();
      return { options: {} };
    },
    validateResult(reply) {
      if (!reply.ok) {
        throw new UsageCostWorkerReplyError(reply.error);
      }
    },
  });
}

type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  nativeSequence: number;
  retiredSequence: number;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  rotation?: Promise<void>;
};

type SessionCostWorkerLane = SessionDatabaseWorkerLane & {
  pool: WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>;
};

type SessionDatabaseCleanup = { run: () => Promise<void> };

type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
  generation: number;
  pending: number;
  revoked: boolean;
  nativeSequences: Map<SessionDatabaseWorkerLane, number>;
  hostEffects: Set<Promise<unknown>>;
  cleanups: Set<SessionDatabaseCleanup>;
  aborters: Set<() => void>;
  closing?: Promise<void>;
  unregister: () => void;
};

export type SessionHistoryWorkerDatabase = {
  generation: number;
  assertCurrent: () => void;
  run: (
    prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
    inputBytes: number,
  ) => Promise<SessionHistoryWorkerResult>;
  readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
  readMembers: (
    input: Omit<SessionMembersWorkerInput, "kind" | "database">,
  ) => Promise<SessionMember[]>;
  readUsageCache: (
    input: Omit<SessionUsageCacheWorkerInput, "kind" | "database">,
  ) => Promise<SessionCostUsageCacheReadResult>;
};

type SessionCostUsageWorkerOptions = Pick<
  WorkerTaskOptions<UsageCostWorkerInput>,
  "signal" | "onRequest" | "inputBytes" | "timeoutMs" | "transferList" | "onInputConsumed"
> & { beforeDispatch?: () => void };

export type SessionCostUsageWorkerScope = {
  assertCurrent: () => void;
  run: (
    input: UsageCostWorkerInput,
    options: SessionCostUsageWorkerOptions,
  ) => Promise<UsageCostWorkerResult>;
  /** Register before acquisition can wait; a failed cleanup stays owned for close retry. */
  retainCleanup: (close: () => Promise<void>) => () => void;
};

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope({ ...input, env });
  const resolved = resolveSqliteScope({ ...input, storePath, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const scope: SessionRowPresenceWorkerInput["scope"] = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: databasePath,
    databaseAgentId: options.agentId,
    env,
  };
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: incognito
      ? async () => loadSessionEntryReadOnlyInScope(scope) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}

/** Full membership evidence shares the existing read-only agent database worker. */
export async function listSessionMembersInWorker(
  input: SessionAccessScope,
): Promise<SessionMember[]> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...input, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    // Incognito SQLite exists only in this process and keeps its native owner.
    return listSessionMembers({ ...input, env });
  }
  return await withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readMembers({ sessionKey: resolved.sessionKey, env }),
  );
}

const historyDatabases = new Map<string, HistoryDatabaseResource>();
const runInHistoryOwnerContext = AsyncLocalStorage.snapshot();
const historySetTimeout = setTimeout;
const historyClearTimeout = clearTimeout;
let historyGeneration = 0;
const historyLane: SessionDatabaseWorkerLane = {
  name: "Session history",
  pool: historyPages,
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};
const costReadLane: SessionCostWorkerLane = {
  name: "Session usage read",
  pool: createUsageCostPool("read"),
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};
const costRefreshLane: SessionCostWorkerLane = {
  name: "Session usage refresh",
  pool: createUsageCostPool("refresh"),
  nativeSequence: 0,
  retiredSequence: 0,
  pending: 0,
};

function pruneHistoryDatabases(): void {
  for (const [key, resource] of historyDatabases) {
    if (
      resource.pending === 0 &&
      resource.nativeSequences.size === 0 &&
      resource.hostEffects.size === 0 &&
      resource.cleanups.size === 0 &&
      !resource.closing
    ) {
      resource.unregister();
      historyDatabases.delete(key);
    }
  }
}

function releaseRetiredDatabaseCustody(lane: SessionDatabaseWorkerLane, through: number): void {
  lane.retiredSequence = Math.max(lane.retiredSequence, through);
  for (const resource of historyDatabases.values()) {
    const sequence = resource.nativeSequences.get(lane);
    if (sequence !== undefined && sequence <= through) {
      resource.nativeSequences.delete(lane);
    }
  }
  pruneHistoryDatabases();
}

function rotateDatabaseWorkers(lane: SessionDatabaseWorkerLane): Promise<void> {
  const through = lane.nativeSequence;
  // rotate pauses dispatch synchronously; later factories receive a greater sequence.
  const rotation = lane.pool.rotate().then(() => releaseRetiredDatabaseCustody(lane, through));
  lane.rotation = rotation;
  const finished = () => {
    if (lane.rotation === rotation) {
      lane.rotation = undefined;
    }
  };
  void rotation.then(finished, finished);
  return rotation;
}

// Missing reads can leave an idle worker without retaining any database custody.
function armDatabaseWorkerIdleRetirement(lane: SessionDatabaseWorkerLane): void {
  historyClearTimeout(lane.idleTimer);
  if (lane.nativeSequence <= lane.retiredSequence || lane.pending > 0) {
    return;
  }
  lane.idleTimer = runInHistoryOwnerContext(() =>
    historySetTimeout(() => {
      void rotateDatabaseWorkers(lane).catch((error: unknown) => {
        process.emitWarning(`${lane.name} worker retirement failed: ${String(error)}`);
      });
    }, 30 * 60_000),
  );
  lane.idleTimer.unref();
}

function clearClosedDatabaseCustody(
  lane: SessionDatabaseWorkerLane,
  through: number,
  databases: readonly UsageCostWorkerDatabase[],
): void {
  for (const database of databases) {
    const resource = historyDatabases.get(JSON.stringify(database));
    const sequence = resource?.nativeSequences.get(lane);
    if (resource && sequence !== undefined && sequence <= through) {
      resource.nativeSequences.delete(lane);
    }
  }
}

function acquireHistoryDatabaseResource(
  options: OpenClawAgentDatabaseOptions,
): HistoryDatabaseResource {
  const database = {
    agentId: normalizeAgentId(options.agentId),
    path: resolveOpenClawAgentSqlitePath(options),
  };
  const key = JSON.stringify(database);
  let resource = historyDatabases.get(key);
  if (!resource || resource.revoked) {
    const owned: HistoryDatabaseResource = {
      database,
      generation: ++historyGeneration,
      pending: 0,
      revoked: false,
      nativeSequences: new Map(),
      hostEffects: new Set(),
      cleanups: new Set(),
      aborters: new Set(),
      unregister: () => {},
    };
    const close = () => {
      if (!owned.closing) {
        owned.closing = (async () => {
          await Promise.all([...owned.nativeSequences.keys()].map(rotateDatabaseWorkers));
          await Promise.allSettled(owned.hostEffects);
          for (const cleanup of owned.cleanups) {
            await cleanup.run();
          }
        })().finally(() => {
          owned.closing = undefined;
          pruneHistoryDatabases();
          armDatabaseWorkerIdleRetirement(historyLane);
          armDatabaseWorkerIdleRetirement(costReadLane);
          armDatabaseWorkerIdleRetirement(costRefreshLane);
        });
        void owned.closing.catch(() => {});
      }
      return owned.closing;
    };
    owned.unregister = registerOpenClawAgentDatabaseAsyncResource({
      ...database,
      revoke: () => {
        owned.revoked = true;
        for (const abort of owned.aborters) {
          abort();
        }
        void close();
      },
      close,
    });
    historyDatabases.set(key, owned);
    resource = owned;
  }
  return resource;
}

/** Capture database custody before restoration or queueing can await. */
export async function withSessionHistoryWorkerDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
): Promise<T> {
  const owned = acquireHistoryDatabaseResource(options);
  const { database } = owned;
  const assertCurrent = () => {
    if (owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
  };
  historyClearTimeout(historyLane.idleTimer);
  historyLane.pending++;
  owned.pending++;
  try {
    assertCurrent();
    const runRequest = async <TResult>(
      prepare: () =>
        | Omit<SessionTranscriptHistoryWorkerInput, "database">
        | Omit<SessionRowPresenceWorkerInput, "database">
        | Omit<SessionMembersWorkerInput, "database">
        | Omit<SessionUsageCacheWorkerInput, "database">,
      inputBytes: number,
      receive: (
        value:
          | SessionHistoryWorkerResult
          | boolean
          | SessionMember[]
          | SessionCostUsageCacheReadResult,
      ) => TResult,
    ): Promise<TResult> => {
      assertCurrent();
      let sequence = 0;
      try {
        const reply = await historyPages.run(
          () => {
            assertCurrent();
            const input = prepare();
            assertCurrent();
            sequence = ++historyLane.nativeSequence;
            owned.nativeSequences.set(historyLane, sequence);
            return { ...input, database };
          },
          { inputBytes, timeoutMs: 60_000 },
        );
        const value = receive(
          unwrapSessionTranscriptWorkerReply<
            "history-page" | "session-row-presence" | "session-members" | "usage-cache"
          >(reply),
        );
        if (reply.ok && reply.closedHistoryDatabase) {
          // A later dispatched request may already hold this target's next native custody.
          clearClosedDatabaseCustody(historyLane, sequence, [reply.closedHistoryDatabase]);
        }
        assertCurrent();
        return value;
      } catch (error) {
        if (sequence > 0) {
          try {
            await rotateDatabaseWorkers(historyLane);
          } catch (cleanupError) {
            throw sessionHistoryCleanupError(error, cleanupError, "worker retirement");
          }
        }
        throw error;
      }
    };
    const result = await operation({
      generation: owned.generation,
      assertCurrent,
      run: async (prepare, inputBytes) =>
        await runRequest(prepare, inputBytes, (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind === "usage-refresh-lock"
          ) {
            throw new Error("Session history worker returned metadata instead of history");
          }
          return value;
        }),
      readUsageCache: async (input) =>
        await runRequest(
          () => ({ kind: "usage-cache", ...input }),
          JSON.stringify(input).length * 2,
          (value) => {
            if (
              typeof value === "boolean" ||
              Array.isArray(value) ||
              value.kind !== "usage-refresh-lock"
            ) {
              throw new Error(
                "Session history worker returned another result instead of usage cache",
              );
            }
            return value;
          },
        ),
      readMembers: async (input) =>
        await runRequest(
          () => ({ kind: "session-members", ...input }),
          JSON.stringify(input).length * 2,
          (value) => {
            if (!Array.isArray(value)) {
              throw new Error("Session history worker returned another result instead of members");
            }
            return value;
          },
        ),
      readEntryPresence: async (scope) =>
        await runRequest(
          () => ({ kind: "session-row-presence", scope }),
          JSON.stringify(scope).length * 2,
          (value) => {
            if (typeof value !== "boolean") {
              throw new Error(
                "Session history worker returned history instead of metadata presence",
              );
            }
            return value;
          },
        ),
    });
    assertCurrent();
    return result;
  } finally {
    owned.pending--;
    historyLane.pending--;
    pruneHistoryDatabases();
    armDatabaseWorkerIdleRetirement(historyLane);
  }
}

/** Usage reads retain every physical store while compute and its admitted host effects settle. */
export async function withSessionCostUsageWorkerDatabases<T>(
  options: readonly OpenClawAgentDatabaseOptions[],
  operation: (owner: SessionCostUsageWorkerScope) => Promise<T>,
): Promise<T> {
  if (options.length === 0) {
    throw new Error("Usage cost work requires its database owners");
  }
  const resources = new Set<HistoryDatabaseResource>();
  try {
    for (const databaseOptions of options) {
      const resource = acquireHistoryDatabaseResource(databaseOptions);
      if (!resources.has(resource)) {
        resources.add(resource);
        resource.pending++;
      }
    }
  } catch (error) {
    for (const resource of resources) {
      resource.pending--;
    }
    pruneHistoryDatabases();
    throw error;
  }
  const pending = new Set<Promise<UsageCostWorkerResult>>();
  const cleanups = new Set<SessionDatabaseCleanup>();
  const lanes = new Map<SessionCostWorkerLane, { nativeThrough: number; failedThrough: number }>();
  let phase: "open" | "closing" | "closed" = "open";
  const assertCurrent = () => {
    if (phase === "closed" || [...resources].some((resource) => resource.revoked)) {
      throw new WorkerTaskError("Session usage database work was revoked", "unavailable");
    }
  };
  const settle = async () => {
    while (pending.size > 0) {
      await Promise.allSettled(pending);
    }
    for (const [lane, custody] of lanes) {
      if (custody.nativeThrough > lane.retiredSequence) {
        await lane.rotation;
      }
      if (custody.failedThrough > lane.retiredSequence) {
        await rotateDatabaseWorkers(lane);
      }
    }
  };
  const retainCleanup = (close: () => Promise<void>): (() => void) => {
    if (phase === "closed") {
      throw new WorkerTaskError("Session usage database scope is closed", "unavailable");
    }
    const runInContext = AsyncLocalStorage.snapshot();
    let released = false;
    let closing: Promise<void> | undefined;
    const release = () => {
      released = true;
      cleanups.delete(cleanup);
      for (const resource of resources) {
        resource.cleanups.delete(cleanup);
      }
      pruneHistoryDatabases();
    };
    const cleanup: SessionDatabaseCleanup = {
      run: () => {
        if (released) {
          return Promise.resolve();
        }
        closing ??= (async () => {
          await settle();
          await runInContext(close);
          release();
        })().catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
        return closing;
      },
    };
    cleanups.add(cleanup);
    for (const resource of resources) {
      resource.cleanups.add(cleanup);
    }
    return release;
  };
  const run = (
    input: UsageCostWorkerInput,
    runOptions: SessionCostUsageWorkerOptions,
  ): Promise<UsageCostWorkerResult> => {
    assertCurrent();
    if (phase !== "open") {
      throw new WorkerTaskError("Session usage database scope is closing", "unavailable");
    }
    const lane = input.operation.kind === "refresh" ? costRefreshLane : costReadLane;
    const custody = lanes.get(lane) ?? { nativeThrough: 0, failedThrough: 0 };
    lanes.set(lane, custody);
    const controller = new AbortController();
    const signal = runOptions.signal
      ? AbortSignal.any([controller.signal, runOptions.signal])
      : controller.signal;
    const abort = () =>
      controller.abort(
        new WorkerTaskError("Session usage database work was revoked", "unavailable"),
      );
    for (const resource of resources) {
      resource.aborters.add(abort);
    }
    historyClearTimeout(lane.idleTimer);
    lane.pending++;
    const hostEffects = new Set<Promise<WorkerTaskResponse>>();
    const onRequest = runOptions.onRequest;
    let sequence = 0;
    let executionSettled = false;
    const task = (async (): Promise<UsageCostWorkerResult> => {
      try {
        const reply = await lane.pool.run(
          () => {
            assertCurrent();
            signal.throwIfAborted();
            runOptions.beforeDispatch?.();
            sequence = ++lane.nativeSequence;
            custody.nativeThrough = sequence;
            for (const resource of resources) {
              resource.nativeSequences.set(lane, sequence);
            }
            return { ...input, databases: [...resources].map((resource) => resource.database) };
          },
          {
            ...runOptions,
            signal,
            onExecutionSettled: ({ retired }) => {
              executionSettled = true;
              if (retired && sequence > 0) {
                releaseRetiredDatabaseCustody(lane, sequence);
              }
            },
            onRequest: onRequest
              ? (value, context) => {
                  const effect = createDeferredCore<WorkerTaskResponse>();
                  hostEffects.add(effect.promise);
                  for (const resource of resources) {
                    resource.hostEffects.add(effect.promise);
                  }
                  const releaseEffect = () => {
                    hostEffects.delete(effect.promise);
                    for (const resource of resources) {
                      resource.hostEffects.delete(effect.promise);
                    }
                  };
                  void effect.promise.then(releaseEffect, releaseEffect);
                  try {
                    assertCurrent();
                    context.signal.throwIfAborted();
                    effect.resolve(onRequest(value, context));
                  } catch (error) {
                    effect.reject(error);
                  }
                  return effect.promise;
                }
              : undefined,
          },
        );
        if (!reply.ok) {
          throw new UsageCostWorkerReplyError(reply.error);
        }
        clearClosedDatabaseCustody(lane, sequence, reply.closedDatabases);
        signal.throwIfAborted();
        assertCurrent();
        return reply.value;
      } catch (error) {
        if (sequence > 0 && !executionSettled) {
          custody.failedThrough = Math.max(custody.failedThrough, sequence);
          try {
            await rotateDatabaseWorkers(lane);
          } catch (cleanupError) {
            throw withSqliteWorkerCleanupFailure(
              toErrorObject(error, "Usage cost worker failed"),
              cleanupError,
            );
          }
        }
        throw error;
      } finally {
        // Native worker exit does not settle an already admitted host write.
        await Promise.allSettled(hostEffects);
        for (const resource of resources) {
          resource.aborters.delete(abort);
        }
        lane.pending--;
        pruneHistoryDatabases();
        armDatabaseWorkerIdleRetirement(lane);
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    assertCurrent();
    const value = await operation({ assertCurrent, run, retainCleanup });
    assertCurrent();
    result = { ok: true, value };
  } catch (error) {
    result = { ok: false, error };
  }
  phase = "closing";
  try {
    await settle();
    for (const cleanup of cleanups) {
      await cleanup.run();
    }
    if (result.ok) {
      assertCurrent();
    }
  } catch (cleanupError) {
    throw result.ok
      ? cleanupError
      : withSqliteWorkerCleanupFailure(
          toErrorObject(result.error, "Usage cost operation failed"),
          cleanupError,
        );
  } finally {
    phase = "closed";
    for (const resource of resources) {
      resource.pending--;
    }
    pruneHistoryDatabases();
    for (const lane of lanes.keys()) {
      armDatabaseWorkerIdleRetirement(lane);
    }
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
