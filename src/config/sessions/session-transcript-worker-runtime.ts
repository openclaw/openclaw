import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerInput,
  type UsageCostWorkerResult,
} from "../../infra/session-cost-usage-worker.types.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions, WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
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
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  clearClosedDatabaseCustody,
  costReadLane,
  costRefreshLane,
  historyClearTimeout,
  historyLane,
  historyPages,
  pruneHistoryDatabases,
  releaseRetiredDatabaseCustody,
  rotateDatabaseWorkers,
  type HistoryDatabaseResource,
  type SessionCostWorkerLane,
  type SessionDatabaseCleanup,
} from "./session-transcript-worker-resources.js";
import type {
  SessionTranscriptHistoryWorkerInput,
  SessionRowPresenceWorkerInput,
  SessionMembersWorkerInput,
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
  SessionUsageCacheWorkerInput,
} from "./session-transcript-worker.types.js";

export type SessionHistoryWorkerDatabase = {
  generation: number;
  assertCurrent: () => void;
  run: (
    prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
    inputBytes: number,
  ) => Promise<SessionHistoryWorkerResult>;
  readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
  readEntries: (
    scope: SessionEntryListWorkerInput["scope"],
  ) => Promise<SessionEntryListWorkerResult["entries"]>;
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

/** Single and batch reads synchronously retain the same lane-aware database owner. */
function retainSessionHistoryWorkerDatabase(options: OpenClawAgentDatabaseOptions) {
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
  const release = () => {
    owned.pending--;
    historyLane.pending--;
    pruneHistoryDatabases();
    armDatabaseWorkerIdleRetirement(historyLane);
  };
  try {
    assertCurrent();
    const runRequest = async <TResult>(
      prepare: () =>
        | Omit<SessionTranscriptHistoryWorkerInput, "database">
        | Omit<SessionRowPresenceWorkerInput, "database">
        | Omit<SessionMembersWorkerInput, "database">
        | Omit<SessionEntryListWorkerInput, "database">
        | Omit<SessionUsageCacheWorkerInput, "database">,
      inputBytes: number,
      receive: (
        value:
          | SessionHistoryWorkerResult
          | boolean
          | SessionMember[]
          | SessionEntryListWorkerResult
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
            | "history-page"
            | "session-row-presence"
            | "session-members"
            | "session-entry-list"
            | "usage-cache"
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
    const owner: SessionHistoryWorkerDatabase = {
      generation: owned.generation,
      assertCurrent,
      run: async (prepare, inputBytes) =>
        await runRequest(prepare, inputBytes, (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind === "session-entry-list" ||
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
      readEntries: async (scope) =>
        await runRequest(
          () => ({ kind: "session-entry-list", scope }),
          JSON.stringify(scope).length * 2,
          (value) => {
            if (
              typeof value === "boolean" ||
              Array.isArray(value) ||
              value.kind !== "session-entry-list"
            ) {
              throw new Error("Session history worker returned another result instead of entries");
            }
            return value.entries;
          },
        ),
    };
    return { owner, release };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Session history reader admission cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Capture every selected store before yielding; a closed target cannot join a later generation. */
export async function withSessionHistoryWorkerDatabases<T>(
  options: readonly OpenClawAgentDatabaseOptions[],
  operation: (owners: readonly SessionHistoryWorkerDatabase[]) => Promise<T>,
): Promise<T> {
  const retained: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
  let outcome: { value: T } | { error: unknown };
  try {
    for (const target of options) {
      retained.push(retainSessionHistoryWorkerDatabase(target));
    }
    const value = await operation(retained.map(({ owner }) => owner));
    for (const { owner } of retained) {
      owner.assertCurrent();
    }
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const retainedRead of retained.toReversed()) {
    try {
      retainedRead.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [...("error" in outcome ? [outcome.error] : []), ...cleanupErrors],
      "Session history read scope cleanup failed",
      { cause: "error" in outcome ? outcome.error : cleanupErrors[0] },
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Single-target callers retain the same batch admission and revocation boundary. */
export function withSessionHistoryWorkerDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
): Promise<T> {
  return withSessionHistoryWorkerDatabases([options], (owners) =>
    operation(expectDefined(owners[0], "retained session history reader")),
  );
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
