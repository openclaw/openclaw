import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
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
import {
  sessionHistoryCleanupError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  clearClosedDatabaseCustody,
  costReadLane,
  costRefreshLane,
  historyClearTimeout,
  historyLane,
  pruneHistoryDatabases,
  releaseRetiredDatabaseCustody,
  rotateDatabaseWorkers,
  type HistoryDatabaseResource,
  type SessionCostWorkerLane,
  type SessionDatabaseCleanup,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionHistoryWorkerInput,
  SessionRowPresenceWorkerInput,
} from "./session-transcript-worker.types.js";

export type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

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
      ? async () => loadSessionEntryReadOnlyInScope({ ...scope, projection: "list" }) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}

/** Single and batch reads synchronously retain the same lane-aware database owner. */
export function retainSessionHistoryWorkerDatabase(
  options: OpenClawAgentDatabaseOptions,
  lane: SessionHistoryWorkerLane = historyLane,
) {
  const owned = acquireHistoryDatabaseResource(options);
  const { database } = owned;
  const assertCurrent = () => {
    if (owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
  };
  historyClearTimeout(lane.idleTimer);
  lane.pending++;
  owned.pending++;
  const release = () => {
    owned.pending--;
    lane.pending--;
    pruneHistoryDatabases();
    armDatabaseWorkerIdleRetirement(lane);
  };
  try {
    assertCurrent();
    const runRequest: SessionHistoryWorkerRequestRunner = async (
      prepare,
      inputBytes,
      receive,
      signal,
      onRequest,
    ) => {
      assertCurrent();
      const deadline = performance.now() + 60_000;
      let sequence = 0;
      let executionRetired = false;
      try {
        const reply = await lane.pool.run(
          () => {
            assertCurrent();
            const input = prepare();
            assertCurrent();
            sequence = ++lane.nativeSequence;
            owned.nativeSequences.set(lane, sequence);
            return { ...input, database };
          },
          {
            inputBytes,
            timeoutMs: 60_000,
            signal,
            onRequest: onRequest
              ? async (value, context) => {
                  context.signal.throwIfAborted();
                  assertCurrent();
                  onRequest(value);
                  assertCurrent();
                  const remaining = deadline - performance.now();
                  if (remaining <= 0) {
                    throw new WorkerTaskError("worker task timed out", "timeout");
                  }
                  return { input: null, timeoutMs: remaining };
                }
              : undefined,
            onExecutionSettled: ({ retired }) => {
              if (retired) {
                executionRetired = true;
                releaseRetiredDatabaseCustody(lane, sequence);
              }
            },
          },
        );
        const value = receive(
          unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply),
        );
        if (reply.ok && reply.closedHistoryDatabase) {
          // A later dispatched request may already hold this target's next native custody.
          clearClosedDatabaseCustody(lane, sequence, [reply.closedHistoryDatabase]);
        }
        assertCurrent();
        return value;
      } catch (error) {
        if (sequence > 0 && !executionRetired) {
          try {
            await rotateDatabaseWorkers(lane);
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
      ...createSessionHistoryWorkerReaders(runRequest),
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
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  const retained: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
  let outcome: { value: T } | { error: unknown };
  try {
    for (const target of options) {
      retained.push(retainSessionHistoryWorkerDatabase(target, lane));
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
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  return withSessionHistoryWorkerDatabases(
    [options],
    (owners) => operation(expectDefined(owners[0], "retained session history reader")),
    lane,
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
