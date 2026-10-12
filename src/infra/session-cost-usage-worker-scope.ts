import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  clearClosedDatabaseCustody,
  costReadLane,
  costRefreshLane,
  historyClearTimeout,
  pruneHistoryDatabases,
  refreshDatabaseWorkerPressureSubscription,
  releaseRetiredDatabaseCustody,
  rotateDatabaseWorkers,
  type HistoryDatabaseResource,
  type SessionCostWorkerLane,
  type SessionDatabaseCleanup,
} from "../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerInput,
  type UsageCostWorkerResult,
  type SessionCostUsageWorkerOptions,
  type SessionCostUsageWorkerScope,
} from "./session-cost-usage-worker.types.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import { withSqliteWorkerCleanupFailure } from "./sqlite-worker-broker-reply.js";
import { WorkerTaskError } from "./worker-task-pool.js";
import type { WorkerTaskResponse } from "./worker-task-pool.types.js";

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
    refreshDatabaseWorkerPressureSubscription();
    const hostEffects = new Set<Promise<WorkerTaskResponse>>();
    const onRequest = runOptions.onRequest;
    let sequence = 0;
    let executionSettled = false;
    const task = (async (): Promise<UsageCostWorkerResult> => {
      try {
        const reply = await runWithSqliteDatabaseAdmissionTurn(
          [...resources].map((resource) => resource.database.path),
          () =>
            lane.pool.run(
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
            ),
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
