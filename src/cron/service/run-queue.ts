import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { waitForAgentDatabasePreparation } from "../../state/agent-database-preparation-context.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { CronEventClaimInvalidatedError } from "../event-source.js";
import { captureCronMutationCommit } from "../mutation-completion.js";
import { currentPluginCommandHostProcessId } from "../plugin-command-schedule.js";
import { getCronJobsStoreRevision } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type {
  CronQueuedRun,
  CronRunQueueOperations,
  CronRunRequestContext,
  CronSkippedRequest,
} from "../store/run-queue.types.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { locked } from "./locked.js";
import { resolveCurrentDefaultAgentId } from "./ops-shared.js";
import type { ManualRunOptions } from "./run-options.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { launchCronRun, type CronLaunchContext } from "./run-queue-execution.js";
import {
  createCronRunRequests,
  projectCronRunQueueRequests,
  type CronRunOptions as RunOptions,
} from "./run-queue-requests.js";
import {
  listCronRunQueueOwners,
  registerCronRunQueue,
  releaseCronRunQueue,
  wakeCronRunQueues,
} from "./run-queue-wake.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { preparingCronAgentIds } from "./scheduler-config.js";
import {
  emit,
  isImmediateCronRunMode,
  type CronRunMode,
  type CronRunResult,
  type CronServiceState,
} from "./state.js";
import { captureCronServiceMutationSource, noteLoadedCronStoreCommit } from "./store.js";

type LaunchState = {
  contexts: Map<string, CronLaunchContext>;
  running: Set<Promise<unknown>>;
  drain?: Promise<void>;
};
const launchStates = new WeakMap<CronServiceState, LaunchState>();
function launchState(state: CronServiceState): LaunchState {
  let current = launchStates.get(state);
  if (!current) {
    current = { contexts: new Map(), running: new Set() };
    launchStates.set(state, current);
  }
  return current;
}

export type RequestedCronRun = CronQueuedRun & {
  completion: Promise<CronRunResult>;
  activation: Promise<void>;
};

function pumpCronRunQueues(state: CronServiceState, wake = true): void {
  const queue = launchState(state);
  if (!queue.contexts.size && !queue.running.size) {
    releaseCronRunQueue(state);
  }
  if (wake) {
    wakeCronRunQueues(state);
  }
}

function watchCronRunCancellation(state: CronServiceState, pending: CronLaunchContext): void {
  const signal = pending.options.onExit?.signal;
  if (!signal) {
    return;
  }
  const cancel = () => {
    void cancelCronRunRequests(
      state,
      [pending.receipt.receiptId],
      "cron on-exit request cancelled",
    ).catch((error: unknown) => {
      pending.completion.reject(error);
      state.deps.log.warn({ err: String(error) }, "cron: queued cancellation failed");
    });
  };
  pending.removeCancellation = () => signal.removeEventListener("abort", cancel);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
}

/** Adopt committed worker requests without taking ownership of queue order or capacity. */
export function adoptCronRunRequests(
  state: CronServiceState,
  accepted: CronQueuedRun[],
  options: RunOptions,
  context = captureOpenClawStateWorkerContext(),
  generation = state.lifecycleGeneration,
): RequestedCronRun[] {
  const batch = { notified: false };
  return accepted.map((entry) => {
    const launch: CronLaunchContext = {
      receipt: entry.runReceipt,
      context,
      options: Object.assign({}, options, {
        scheduleOwnershipAtMs: options.scheduleOwnershipAtMs ?? entry.runReceipt.startedAtMs,
      }),
      generation,
      batch,
      completion: createDeferredCore<CronRunResult>(),
      activation: createDeferredCore(),
    };
    void launch.completion.promise.catch(() => {});
    launchState(state).contexts.set(entry.runReceipt.receiptId, launch);
    registerCronRunQueue(state, () => drainCronRunQueue(state));
    watchCronRunCancellation(state, launch);
    return Object.assign({}, entry, {
      completion: launch.completion.promise,
      activation: launch.activation.promise,
    });
  });
}

export async function commitCronRunRequests(
  state: CronServiceState,
  jobs: readonly CronJob[],
  options: ManualRunOptions & { mode?: CronRunMode; source: "manual" },
): Promise<RequestedCronRun[]> {
  if (state.stopped || jobs.length === 0) {
    return [];
  }
  const source = captureCronServiceMutationSource(state);
  const nowMs = state.deps.nowMs();
  const generation = state.lifecycleGeneration;
  const candidates = await skipCronJobsWithoutOwners(state, [...jobs], nowMs, {
    source,
    ...(isImmediateCronRunMode(options.mode) ? { scheduleMode: "preserve" as const } : {}),
    manualRun: options,
  });
  source.assertCurrent();
  options.commitGuard?.();
  const requests = createCronRunRequests(candidates, options, nowMs);
  const markCommitted = captureCronMutationCommit("cron.run");
  const assertRequestCurrent = () => {
    options.commitGuard?.();
    source.assertCurrent();
  };
  const observedRevision = getCronJobsStoreRevision(source.storeKey);
  const result = await runOpenClawStateWorkerOperation(
    source.context,
    (scope) =>
      scope.execute({
        type: "cron.requestRuns",
        input: {
          storeKey: source.storeKey,
          nowMs,
          defaultAgentId: resolveCurrentDefaultAgentId(state),
          requests,
        },
      }),
    {
      assertCurrent: assertRequestCurrent,
      createAdmission: options.event
        ? createSqliteWorkerWriteAdmission(assertRequestCurrent, [
            source.context.admission.databasePath,
          ])
        : undefined,
    },
  );
  if (result.rejected.some(({ reason }) => reason === "event-invalidated")) {
    throw new CronEventClaimInvalidatedError();
  }
  const accepted = adoptCronRunRequests(
    state,
    result.accepted,
    options,
    source.context,
    generation,
  );
  if (accepted.length > 0) {
    markCommitted?.();
    applyCronRuntimeRowsToState(
      state,
      accepted.map(({ job }) => job),
    );
    noteLoadedCronStoreCommit(state, observedRevision);
    options.onExit?.onReserved();
  }
  return accepted;
}

function publishSkipped(state: CronServiceState, skipped: CronSkippedRequest) {
  const pending = launchState(state).contexts.get(skipped.runReceipt.receiptId);
  if (!pending) {
    return;
  }
  pending.preparation?.controller.abort();
  pending.removeCancellation?.();
  pending.activation.resolve();
  launchState(state).contexts.delete(skipped.runReceipt.receiptId);
  // The worker writes skipped history with the same receipt; events are best effort.
  emit(state, {
    jobId: skipped.runReceipt.jobId,
    job: skipped.job,
    action: "finished",
    status: "skipped",
    error: skipped.error,
    runId: pending.options.runId,
    runAtMs: skipped.runReceipt.startedAtMs,
    durationMs: 0,
    nextRunAtMs: skipped.job?.state.nextRunAtMs,
  });
  if (pending.options.terminalTracker) {
    pending.options.terminalTracker.emitted = true;
  }
  if (skipped.eventInvalidated) {
    pending.completion.reject(new CronEventClaimInvalidatedError());
  } else {
    pending.completion.resolve({
      ok: true,
      ran: false,
      reason:
        state.stopped ||
        pending.generation !== state.lifecycleGeneration ||
        pending.options.onExit?.signal.aborted
          ? "stopped"
          : "not-due",
    });
  }
  if (!launchState(state).contexts.size && !launchState(state).running.size) {
    releaseCronRunQueue(state);
  }
}

async function cancelCronRunRequests(
  state: CronServiceState,
  receiptIds: string[],
  reason: string,
) {
  if (receiptIds.length === 0) {
    return;
  }
  const context =
    launchState(state).contexts.get(receiptIds[0]!)?.context ?? captureOpenClawStateWorkerContext();
  const observedRevision = getCronJobsStoreRevision(state.deps.storePath);
  const result = await runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({
      type: "cron.cancelRequests",
      input: {
        storeKey: cronStoreKey(state.deps.storePath),
        receiptIds,
        nowMs: state.deps.nowMs(),
        reason,
      },
    }),
  );
  applyCronRuntimeRowsToState(
    state,
    result.skipped.flatMap(({ job }) => (job ? [job] : [])),
  );
  noteLoadedCronStoreCommit(state, observedRevision);
  for (const skipped of result.skipped) {
    publishSkipped(state, skipped);
  }
}

export function getCronRunQueueRequests(
  state: CronServiceState,
  selection: { includePendingEvents?: boolean } = {},
): CronRunRequestContext[] {
  return projectCronRunQueueRequests(launchState(state).contexts.values(), selection);
}

/** Consume committed activations. No host semaphore or reservation influences selection. */
export async function drainCronRunQueue(state: CronServiceState): Promise<void> {
  if (
    state.stopped ||
    (![...launchState(state).contexts.values()].some((pending) => !pending.started) &&
      !state.store?.jobs.some((job) => job.state.queuedAtMs !== undefined))
  ) {
    return;
  }
  if (launchState(state).drain) {
    return await launchState(state).drain;
  }
  let retryAfterGuardRefusal = false;
  launchState(state).drain = locked(state, async () => {
    const context = captureOpenClawStateWorkerContext();
    const pendingEvents = [...launchState(state).contexts.values()].filter(
      (pending) => pending.options.event && !pending.started && !pending.eventTransferred,
    );
    const guardFailure: { value?: { pending: CronLaunchContext; error: unknown } } = {};
    const assertEventSourcesCurrent = () => {
      for (const pending of pendingEvents) {
        try {
          pending.options.commitGuard?.();
        } catch (error) {
          guardFailure.value = { pending, error };
          throw error;
        }
      }
    };
    const observedRevision = getCronJobsStoreRevision(state.deps.storePath);
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "cron.drainQueue",
          input: {
            storeKey: cronStoreKey(state.deps.storePath),
            nowMs: state.deps.nowMs(),
            defaultAgentId: resolveCurrentDefaultAgentId(state),
            maxConcurrentRuns: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
            schedulingPaused: state.schedulingPaused,
            preparingAgentIds: preparingCronAgentIds(state.deps.env),
            requests: getCronRunQueueRequests(state, { includePendingEvents: true }),
            hostProcessId: currentPluginCommandHostProcessId(),
            pluginCommandHosts: state.deps.resolvePluginCommandScheduleHosts?.(),
          },
        }),
      {
        assertCurrent: assertEventSourcesCurrent,
        createAdmission:
          pendingEvents.length > 0
            ? createSqliteWorkerWriteAdmission(assertEventSourcesCurrent, [
                context.admission.databasePath,
              ])
            : undefined,
      },
    ).catch(async (error: unknown) => {
      const refused = guardFailure.value;
      if (refused && refused.error === error && !hasSqliteWorkerOutcomeUnknown(error)) {
        // The whole transaction rolled back, but only this source lost authority.
        // Its exception must never reach a sibling ingress owner and dead-letter it.
        refused.pending.completion.reject(error);
        refused.pending.activation.resolve();
        try {
          await cancelCronRunRequests(
            state,
            [refused.pending.receipt.receiptId],
            normalizeCronRunErrorText(error),
          );
        } catch (cleanupError) {
          state.deps.log.warn({ err: String(cleanupError) }, "cron: deferred event cleanup");
        } finally {
          // A missing cleanup row is already settled; uncertain cleanup stays
          // durable for recovery, never in the live source-admission loop.
          refused.pending.removeCancellation?.();
          launchState(state).contexts.delete(refused.pending.receipt.receiptId);
        }
        retryAfterGuardRefusal = true;
        return undefined;
      }
      // Only a known rollback permits releasing queued receipts. Unknown writes stay
      // with ordinary recovery; neither path may replay the immutable ingress here.
      for (const pending of pendingEvents) {
        pending.completion.reject(error);
        pending.activation.resolve();
      }
      if (!hasSqliteWorkerOutcomeUnknown(error)) {
        await cancelCronRunRequests(
          state,
          pendingEvents.map(({ receipt }) => receipt.receiptId),
          normalizeCronRunErrorText(error),
        );
      } else {
        for (const pending of pendingEvents) {
          launchState(state).contexts.delete(pending.receipt.receiptId);
        }
        if (!launchState(state).contexts.size && !launchState(state).running.size) {
          releaseCronRunQueue(state);
        }
      }
      throw error;
    });
    if (result) {
      await launchCronRunQueueResult(state, result, context, observedRevision);
    }
  }).finally(() => {
    launchState(state).drain = undefined;
    if (retryAfterGuardRefusal) {
      pumpCronRunQueues(state);
    }
  });
  await launchState(state).drain;
}

/** Publish and execute activations already committed by the queue owner. */
export async function launchCronRunQueueResult(
  state: CronServiceState,
  result: CronRunQueueOperations["cron.drainQueue"]["output"],
  context = captureOpenClawStateWorkerContext(),
  observedRevision = getCronJobsStoreRevision(state.deps.storePath),
): Promise<void> {
  if (result.launches.length || result.skipped.length) {
    const jobs = [...result.skipped, ...result.launches].flatMap(({ job }) => (job ? [job] : []));
    applyCronRuntimeRowsToState(state, jobs);
    noteLoadedCronStoreCommit(state, observedRevision);
  }
  for (const skipped of result.skipped) {
    publishSkipped(state, skipped);
  }
  for (const entry of [...result.preparing, ...result.launches]) {
    const preparing = result.preparing.includes(entry);
    let pending = launchState(state).contexts.get(entry.runReceipt.receiptId);
    if (!pending) {
      pending = {
        receipt: entry.runReceipt,
        context,
        options: {},
        generation: state.lifecycleGeneration,
        batch: { notified: false },
        completion: createDeferredCore<CronRunResult>(),
        activation: createDeferredCore(),
      };
      // Recovered requests have no caller waiting on their completion.
      void pending.completion.promise.catch(() => {});
      launchState(state).contexts.set(entry.runReceipt.receiptId, pending);
      registerCronRunQueue(state, () => drainCronRunQueue(state));
    }
    pending.receipt = entry.runReceipt;
    if (preparing && pending.preparation?.agentId === entry.runReceipt.agentId) {
      continue;
    }
    pending.preparation?.controller.abort();
    const preparation = preparing
      ? { agentId: entry.runReceipt.agentId, controller: new AbortController() }
      : undefined;
    pending.preparation = preparation;
    if (!preparing && pending.options.event) {
      // Publish the committed transfer before any awaited launch preparation.
      pending.eventTransferred = true;
      pending.options.onEventTransferred?.(entry.runReceipt);
      pending.activation.resolve();
    }
    const launch = pending;
    // The launch owns its lifetime beyond the request acknowledgement and store lock.
    const running = runWithGatewayDetachedWorkContinuation(
      () =>
        Promise.resolve().then(() =>
          runOutsideOperatorToolGatewayAuthority(() => {
            const run = async () => {
              if (preparation) {
                try {
                  await waitForAgentDatabasePreparation(preparation.agentId, {
                    env: state.deps.env,
                    signal: AbortSignal.any([
                      state.schedulerScope.signal,
                      preparation.controller.signal,
                    ]),
                  });
                } catch (error) {
                  // Observation only rejects on lifecycle cancellation.
                  preparation.controller.abort();
                  throw error;
                }
                assertAgentDatabaseAdmitted(preparation.agentId, { env: state.deps.env });
                // A stale readiness snapshot can settle immediately; wake after this drain unlocks.
                await state.op;
              } else {
                await launchCronRun(state, entry, launch, (reason) =>
                  cancelCronRunRequests(state, [entry.runReceipt.receiptId], reason),
                );
                launchState(state).contexts.delete(entry.runReceipt.receiptId);
              }
            };
            return state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run();
          }),
        ),
      "cron:run",
    )
      .catch(async (error: unknown) => {
        if (
          launchState(state).contexts.get(entry.runReceipt.receiptId) !== launch ||
          (preparation && launch.preparation !== preparation)
        ) {
          return;
        }
        try {
          if (preparation?.controller.signal.aborted) {
            // Keep durable custody for recovery; terminal inspection failures
            // instead wake the queue and pass through ordinary eligibility.
            launch.completion.resolve({ ok: true, ran: false, reason: "stopped" });
            return;
          }
          state.deps.log.error(
            { jobId: entry.job.id, err: String(error) },
            "cron: queued launch failed",
          );
          launch.completion.reject(error);
          if (!launch.started) {
            await cancelCronRunRequests(
              state,
              [entry.runReceipt.receiptId],
              normalizeCronRunErrorText(error),
            );
          }
        } catch (cleanupError) {
          state.deps.log.warn(
            { err: String(cleanupError) },
            "cron: failed launch left for recovery",
          );
        } finally {
          launch.activation.resolve();
          launch.removeCancellation?.();
          launchState(state).contexts.delete(entry.runReceipt.receiptId);
        }
      })
      .finally(() => {
        if (launch.preparation === preparation) {
          launch.preparation = undefined;
        }
        launchState(state).running.delete(running);
        pumpCronRunQueues(state, !preparation?.controller.signal.aborted);
      });
    launchState(state).running.add(running);
  }
}

export async function stopCronRunQueue(state: CronServiceState) {
  await launchState(state).drain;
  const queued = [...launchState(state).contexts.values()].filter(
    ({ receipt }) =>
      state.store?.jobs.find((job) => job.id === receipt.jobId)?.state.runningReceiptId !==
      receipt.receiptId,
  );
  for (const pending of queued) {
    pending.preparation?.controller.abort();
  }
  await cancelCronRunRequests(
    state,
    queued.filter((pending) => !pending.preparation).map(({ receipt }) => receipt.receiptId),
    "cron service stopped",
  );
}

export async function waitForCronRunQueue(state: CronServiceState) {
  await launchState(state).drain;
  await Promise.allSettled(launchState(state).running);
}

/** Waits for one job's owned work across facades of the same store. */
export async function waitForCronJobRun(state: CronServiceState, jobId: string): Promise<boolean> {
  const runs = listCronRunQueueOwners(state).flatMap((owner) =>
    [...launchState(owner).contexts.values()]
      .filter((pending) => pending.receipt.jobId === jobId)
      .map((pending) => pending.completion.promise),
  );
  await Promise.allSettled(runs);
  return runs.length > 0;
}
