import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { BroadcastChannel } from "node:worker_threads";
import { isAbortError, waitForAbortSignal } from "../../infra/abort-signal.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createOpenClawStateWorkerLease,
  type OpenClawStateWorkerLease,
} from "../../state/openclaw-state-worker-store.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { getCronJobsStoreRevision } from "../store.js";
import type {
  CronSchedulerOperations,
  CronSchedulerResult,
} from "../store/scheduler-actor.types.js";
import { locked } from "./locked.js";
import { registerCronSchedulerRefresh } from "./run-queue-wake.js";
import {
  adoptCronRunRequests,
  drainCronRunQueue,
  getCronRunQueueRequests,
  launchCronRunQueueResult,
} from "./run-queue.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { captureCronSchedulerSnapshot } from "./scheduler-config.js";
import { runCronSchedulerMaintenance } from "./scheduler-maintenance.js";
import { emit, type CronServiceState } from "./state.js";
import { noteLoadedCronStoreCommit, runPostPersistCronNotifications } from "./store.js";

type ActorConnection = {
  assertCurrent: () => void;
  lease?: OpenClawStateWorkerLease;
  borrowedLease?: OpenClawStateWorkerLease;
  acquireLease: () => OpenClawStateWorkerLease;
  channel: BroadcastChannel;
  channelName: string;
  unsubscribe: () => void;
  unregister: () => void;
  releaseRefresh: () => void;
  pending: Promise<void>;
  refreshAfter?: Promise<unknown>;
  nativeLost?: boolean;
};

const connections = new WeakMap<CronServiceState, ActorConnection>();
const recoveries = new WeakSet<CronServiceState>();

function executeScheduler(
  state: CronServiceState,
  connection: ActorConnection,
  command: {
    type: "cron.schedulerStart" | "cron.schedulerRefresh";
    input: CronSchedulerOperations["cron.schedulerStart"]["input"];
  },
): Promise<CronSchedulerResult> {
  if (connection.lease) {
    return connection.lease.execute(command);
  }
  // Disabled scheduling needs reconciliation, but no timer that pins the native actor.
  // Serialize each borrow through Stop so one finalizer cannot remove its successor.
  const pending = connection.pending
    .catch(() => {})
    .then(async () => {
      if (connections.get(state) !== connection || state.stopped) {
        throw new Error("Cron scheduler is closed");
      }
      const lease = connection.acquireLease();
      connection.borrowedLease = lease;
      try {
        // A prior borrow may have retired the actor. With automatic runs disabled,
        // Start performs the same snapshot/settlement work as Refresh without catch-up.
        return await lease.execute({ type: "cron.schedulerStart", input: command.input });
      } finally {
        try {
          await lease.release();
        } finally {
          connection.borrowedLease = undefined;
        }
      }
    });
  connection.pending = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

async function publish(
  state: CronServiceState,
  result: CronSchedulerResult,
  observedRevision: number,
): Promise<number> {
  if (result.jobs.length > 0) {
    applyCronRuntimeRowsToState(state, result.jobs);
    noteLoadedCronStoreCommit(state, observedRevision);
  }
  for (const log of result.logs) {
    state.deps.log[log.level](log.fields, log.message);
  }
  for (const job of result.ownerless) {
    emit(state, {
      jobId: job.id,
      action: "finished",
      job,
      status: "skipped",
      completionStatus: "failed",
      error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      runAtMs: job.state.lastRunAtMs,
      durationMs: 0,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
  const publishedRevision = getCronJobsStoreRevision(state.deps.storeKey);
  await runPostPersistCronNotifications(state, result.notifications);
  return publishedRevision;
}

export async function startCronScheduler(
  state: CronServiceState,
  skipJobIds: ReadonlySet<string>,
): Promise<void> {
  if (connections.has(state)) {
    return;
  }
  const channelName = `openclaw.cron.${randomUUID()}`;
  const generation = state.lifecycleGeneration;
  const storeKey = state.deps.storeKey;
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  const context = captureOpenClawStateWorkerContext();
  const acquireLease = (onNativeLost?: () => void) =>
    createOpenClawStateWorkerLease(
      context,
      async (scope) => {
        await scope.execute({ type: "cron.schedulerStop", input: { storeKey, channelName } });
      },
      onNativeLost,
    );
  const lease = state.deps.cronEnabled
    ? acquireLease(() => {
        connection.nativeLost = true;
        refreshCronScheduler(state);
      })
    : undefined;
  const connection: ActorConnection = {
    assertCurrent: () => context.admission.assertCurrent(),
    lease,
    acquireLease,
    channel,
    channelName,
    unsubscribe: () => {},
    unregister: () => {},
    releaseRefresh: () => {},
    pending: Promise.resolve(),
  };
  connections.set(state, connection);
  connection.releaseRefresh = registerCronSchedulerRefresh(
    state,
    () => refreshCronScheduler(state),
    () => drainCronRunQueue(state),
  );
  connection.unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (identity && identity.key !== context.admission.identity.key) {
        return;
      }
      state.stopped = true;
      await state.schedulerScope.stop();
      await closeConnection(state, connection, true);
    },
  });
  channel.addEventListener("message", () => {
    if (connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
      return;
    }
    void runInDetachedAsyncContext(async () => {
      const run = () => tickCronScheduler(state);
      await (state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run());
    }).catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: scheduling delayed; worker will retry");
    });
  });
  connection.unsubscribe = sessionChanges.subscribe((change) => {
    if (
      !("all" in change) ||
      typeof change.scope !== "string" ||
      !change.scope.startsWith("config")
    ) {
      return;
    }
    refreshCronScheduler(state);
  });
  let started = false;
  try {
    await lease?.ready;
    const observedRevision = getCronJobsStoreRevision(storeKey);
    const result = await executeScheduler(state, connection, {
      type: "cron.schedulerStart",
      input: {
        storeKey,
        channelName,
        snapshot: await captureCronSchedulerSnapshot(state),
        nowMs: state.deps.nowMs(),
        monotonicMs: performance.now(),
        skipJobIds: [...skipJobIds],
        deferAgentWork: true,
        liveSinceMs: state.liveSinceMs,
        paused: state.schedulingPaused,
        requests: getCronRunQueueRequests(state),
      },
    });
    const requests = adoptCronRunRequests(
      state,
      result.accepted,
      { source: "startup" },
      context,
      generation,
    );
    started = true;
    state.schedulerStarted = true;
    const publishedRevision = await publish(state, result, observedRevision);
    await locked(state, () => launchCronRunQueueResult(state, result, context, publishedRevision));
    // Readiness observers keep queued custody without holding Gateway initialization.
    const preparingReceiptIds = new Set(
      result.preparing.map(({ runReceipt }) => runReceipt.receiptId),
    );
    const completed = await Promise.allSettled(
      requests
        .filter((request) => !preparingReceiptIds.has(request.runReceipt.receiptId))
        .map((request) => request.completion),
    );
    const failed = completed.find((completion) => completion.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  } catch (error) {
    if (!started) {
      await stopCronScheduler(state);
    }
    throw error;
  }
}

function recoverCronScheduler(state: CronServiceState): void {
  if (recoveries.has(state) || state.schedulingPaused) {
    return;
  }
  recoveries.add(state);
  const generation = state.lifecycleGeneration;
  const recovery = runInDetachedAsyncContext(async () => {
    // Other borrowers keep a dead store published until they settle, so a
    // replacement can lose its worker at once; retry until a live store answers.
    for (let retryMs = 250; ; retryMs = Math.min(retryMs * 2, 30_000)) {
      const lost = connections.get(state);
      const current = () =>
        lost?.nativeLost === true &&
        connections.get(state) === lost &&
        !state.stopped &&
        !state.schedulingPaused &&
        !state.schedulerScope.signal.aborted &&
        state.lifecycleGeneration === generation;
      if (!lost || !current()) {
        return;
      }
      const run = async () => {
        await state.op;
        if (!current()) {
          return;
        }
        // Keep the retired slot while paused; resume can request the same recovery.
        // Join native settlement and host publication before registering another actor.
        await closeConnection(state, lost, true, true);
        if (!current()) {
          return;
        }
        lost.assertCurrent();
        connections.delete(state);
        try {
          await startCronScheduler(state, new Set());
        } catch (error) {
          // Failed startup removed its own connection; keep the lost slot for the next attempt.
          if (!connections.has(state)) {
            connections.set(state, lost);
          }
          state.deps.log.warn({ err: String(error) }, "cron: worker recovery failed");
          return;
        }
        state.deps.log.info({}, "cron: scheduler reconnected after native worker loss");
      };
      await (state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run());
      if (current()) {
        await waitForAbortSignal(
          state.schedulerScope.signal,
          delay(retryMs, undefined, { ref: false }),
        );
      }
    }
  })
    .catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: worker recovery failed");
    })
    .finally(() => {
      recoveries.delete(state);
    });
  state.schedulerDrain = Promise.all([state.schedulerDrain, recovery]).then(() => undefined);
}

/** The worker decides which slots are due; the host only launches committed requests. */
function tickCronScheduler(state: CronServiceState): Promise<void> {
  const connection = connections.get(state);
  if (!connection?.lease || state.stopped || state.schedulingPaused) {
    return Promise.resolve();
  }
  const tick = connection.pending
    .catch(() => {})
    .then(() => runCronSchedulerTick(state, connection));
  connection.pending = tick;
  return tick;
}

async function runCronSchedulerTick(
  state: CronServiceState,
  connection: ActorConnection,
): Promise<void> {
  const lease = connection.lease;
  if (!lease || connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
    return;
  }
  const generation = state.lifecycleGeneration;
  let admission;
  try {
    admission = await beginGatewayRootWorkAdmissionWhenOpen(
      "cron:worker-tick",
      state.schedulerScope.signal,
    );
  } catch (error) {
    if (
      error instanceof GatewayDrainingError ||
      (state.schedulerScope.signal.aborted && isAbortError(error))
    ) {
      return;
    }
    throw error;
  }
  try {
    await admission.run(async () => {
      if (connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
        return;
      }
      await runCronSchedulerMaintenance(state);
      const observedRevision = getCronJobsStoreRevision(state.deps.storeKey);
      const result = await lease.execute({
        type: "cron.schedulerTick",
        input: {
          storeKey: state.deps.storeKey,
          channelName: connection.channelName,
          paused: false,
          requests: getCronRunQueueRequests(state),
          snapshot: await captureCronSchedulerSnapshot(state),
          nowMs: state.deps.nowMs(),
          monotonicMs: performance.now(),
        },
      });
      adoptCronRunRequests(state, result.accepted, { source: "scheduled" }, undefined, generation);
      const publishedRevision = await publish(state, result, observedRevision);
      await locked(state, () =>
        launchCronRunQueueResult(state, result, undefined, publishedRevision),
      );
    });
  } finally {
    admission.release();
  }
}

/** Queue a config/row notification after the current host mutation releases its lock. */
export function refreshCronScheduler(state: CronServiceState): void {
  const connection = connections.get(state);
  if (!connection || state.stopped) {
    return;
  }
  if (connection.nativeLost) {
    recoverCronScheduler(state);
    return;
  }
  const operation = state.op;
  if (connection.refreshAfter === operation) {
    return;
  }
  connection.refreshAfter = operation;
  void operation
    .then(async () => {
      // Share only notifications before capture, behind this same mutation boundary.
      if (connection.refreshAfter === operation) {
        connection.refreshAfter = undefined;
      }
      if (connections.get(state) !== connection || state.stopped) {
        return;
      }
      const snapshot = await captureCronSchedulerSnapshot(state);
      const observedRevision = getCronJobsStoreRevision(state.deps.storeKey);
      await publish(
        state,
        await executeScheduler(state, connection, {
          type: "cron.schedulerRefresh",
          input: {
            storeKey: state.deps.storeKey,
            snapshot,
            channelName: connection.channelName,
            paused: state.schedulingPaused,
            nowMs: state.deps.nowMs(),
          },
        }),
        observedRevision,
      );
    })
    .catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: worker refresh delayed");
    });
}

export async function stopCronScheduler(state: CronServiceState): Promise<void> {
  const connection = connections.get(state);
  if (!connection) {
    return;
  }
  await closeConnection(state, connection, false);
}

async function closeConnection(
  state: CronServiceState,
  connection: ActorConnection,
  retired: boolean,
  preserveConnection = false,
) {
  if (!preserveConnection && connections.get(state) === connection) {
    connections.delete(state);
  }
  connection.unsubscribe();
  connection.channel.close();
  connection.releaseRefresh();
  if (retired) {
    await connection.borrowedLease?.retire();
  }
  await connection.pending.catch(() => {});
  await (retired ? connection.lease?.retire() : connection.lease?.release());
  connection.unregister();
}
