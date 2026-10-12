import { randomUUID } from "node:crypto";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { clearCronJobActive } from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { captureCronMutationCommit } from "../mutation-completion.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronQueuedRun, CronSkippedRequest } from "../store/run-queue.types.js";
import {
  claimLocalCronRunReceiptOwnership,
  listLocallyOwnedCronRunReceiptIds,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import { createCronScheduledRunId } from "../store/run-request-id.js";
import { ownsStreamSource } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import {
  clearManualCronJobActive,
  markManualCronJobActive,
  resolveCurrentDefaultAgentId,
} from "./ops-shared.js";
import { createCronOwnerExecutionIdentityAdmission, createCronRunHandle } from "./run-history.js";
import type { ManualRunOptions } from "./run-options.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { registerCronRunQueue, releaseCronRunQueue, wakeCronRunQueues } from "./run-queue-wake.js";
import { markServiceCronJobActive } from "./run-receipts.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import {
  emit,
  isImmediateCronRunMode,
  type CronRunMode,
  type CronRunResult,
  type CronServiceState,
} from "./state.js";
import { captureCronServiceMutationSource, ensureLoaded } from "./store.js";
import { authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

type RunOptions = ManualRunOptions & {
  mode?: CronRunMode;
  source?: "scheduled" | "startup" | "manual" | "event";
};

/** Transient payloads and reply promises only; the worker owns queue order and capacity. */
type CronLaunchContext = {
  receipt: CronQueuedRun["runReceipt"];
  context: OpenClawStateWorkerContext;
  options: RunOptions;
  generation: number;
  batch: { notified: boolean };
  started?: boolean;
  removeCancellation?: () => void;
  completion: ReturnType<typeof createDeferredCore<CronRunResult>>;
  activation: ReturnType<typeof createDeferredCore<void>>;
};

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

function pumpCronRunQueues(state: CronServiceState): void {
  const queue = launchState(state);
  if (!queue.contexts.size && !queue.running.size) {
    releaseCronRunQueue(state);
  }
  wakeCronRunQueues(state);
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

export async function commitCronRunRequests(
  state: CronServiceState,
  jobs: readonly CronJob[],
  options: RunOptions,
): Promise<RequestedCronRun[]> {
  if (state.stopped || jobs.length === 0) {
    return [];
  }
  const source = captureCronServiceMutationSource(state);
  const nowMs = state.deps.nowMs();
  const generation = state.lifecycleGeneration;
  const manual = options.source === "manual" || options.source === "event";
  const candidates = await skipCronJobsWithoutOwners(state, [...jobs], nowMs, {
    source,
    ...(isImmediateCronRunMode(options.mode) ? { scheduleMode: "preserve" as const } : {}),
    ...(manual ? { manualRun: options } : {}),
  });
  source.assertCurrent();
  options.commitGuard?.();
  const requests = candidates.map((job) => {
    const receiptId = manual
      ? (options.runId ?? `cron-request.${randomUUID()}`)
      : createCronScheduledRunId(source.storeKey, job.id, job.state.nextRunAtMs!);
    return {
      receiptId,
      jobId: job.id,
      configRevision: resolveCronJobConfigRevision(job),
      mode: options.onExit
        ? ("on-exit" as const)
        : manual
          ? options.mode === "force"
            ? ("force" as const)
            : ("if-enabled" as const)
          : ("scheduled" as const),
      scheduledSlotMs: manual ? undefined : job.state.nextRunAtMs,
      onExitSchedule: options.onExit?.schedule,
      preserveSchedule: isImmediateCronRunMode(options.mode),
      scheduleOwnershipAtMs: options.scheduleOwnershipAtMs ?? nowMs,
      requestRunId: manual ? (options.runId ?? receiptId) : undefined,
    };
  });
  const markCommitted = manual ? captureCronMutationCommit("cron.run") : undefined;
  const result = await runOpenClawStateWorkerOperation(source.context, (scope) => {
    source.assertCurrent();
    options.commitGuard?.();
    return scope.execute({
      type: "cron.requestRuns",
      input: {
        storeKey: source.storeKey,
        nowMs,
        defaultAgentId: resolveCurrentDefaultAgentId(state),
        requests,
      },
    });
  });
  const batch = { notified: false };
  const accepted = result.accepted.map((entry) => {
    const launch: CronLaunchContext = {
      receipt: entry.runReceipt,
      context: source.context,
      options: Object.assign({}, options, {
        scheduleOwnershipAtMs: options.scheduleOwnershipAtMs ?? nowMs,
      }),
      generation,
      batch,
      completion: createDeferredCore<CronRunResult>(),
      activation: createDeferredCore(),
    };
    void launch.completion.promise.catch(() => {});
    launchState(state).contexts.set(entry.runReceipt.receiptId, launch);
    registerCronRunQueue(state, () => drainCronRunQueue(state));
    claimLocalCronRunReceiptOwnership(entry.runReceipt);
    watchCronRunCancellation(state, launch);
    return Object.assign({}, entry, {
      completion: launch.completion.promise,
      activation: launch.activation.promise,
    });
  });
  if (accepted.length > 0) {
    markCommitted?.();
    noteCronJobsStoreCommit(source.storeKey);
    applyCronRuntimeRowsToState(
      state,
      accepted.map(({ job }) => job),
    );
    options.onExit?.onReserved();
  }
  return accepted;
}

export async function requestCronRuns(
  state: CronServiceState,
  jobs: readonly CronJob[],
  options: RunOptions = {},
): Promise<RequestedCronRun[]> {
  const requested = await locked(state, () => commitCronRunRequests(state, jobs, options));
  await drainCronRunQueue(state);
  return requested;
}

async function publishSkipped(state: CronServiceState, skipped: CronSkippedRequest) {
  const pending = launchState(state).contexts.get(skipped.runReceipt.receiptId);
  applyCronRuntimeRowsToState(state, skipped.job ? [skipped.job] : []);
  if (!pending) {
    return;
  }
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
  releaseLocalCronRunReceiptOwnership(skipped.runReceipt);
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
  noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
  for (const skipped of result.skipped) {
    await publishSkipped(state, skipped);
  }
}

/** Consume committed activations. No host semaphore or reservation influences selection. */
export async function drainCronRunQueue(state: CronServiceState): Promise<void> {
  if (
    state.stopped ||
    (!launchState(state).contexts.size &&
      !state.store?.jobs.some((job) => job.state.queuedAtMs !== undefined))
  ) {
    return;
  }
  if (launchState(state).drain) {
    await launchState(state).drain;
    return;
  }
  launchState(state).drain = locked(state, async () => {
    const context = captureOpenClawStateWorkerContext();
    const result = await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({
        type: "cron.drainQueue",
        input: {
          storeKey: cronStoreKey(state.deps.storePath),
          nowMs: state.deps.nowMs(),
          defaultAgentId: resolveCurrentDefaultAgentId(state),
          maxConcurrentRuns: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
          schedulingPaused: state.schedulingPaused,
          locallyOwnedReceiptIds: listLocallyOwnedCronRunReceiptIds(),
          requests: [...launchState(state).contexts.values()].map(({ receipt, options }) => ({
            receiptId: receipt.receiptId,
            mode: options.onExit
              ? ("on-exit" as const)
              : options.source === "manual" || options.source === "event"
                ? options.mode === "force"
                  ? ("force" as const)
                  : ("if-enabled" as const)
                : ("scheduled" as const),
            onExitSchedule: options.onExit?.schedule,
          })),
        },
      }),
    );
    if (result.launches.length || result.skipped.length) {
      noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
    }
    for (const skipped of result.skipped) {
      await publishSkipped(state, skipped);
    }
    for (const entry of result.launches) {
      applyCronRuntimeRowsToState(state, [entry.job]);
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
      claimLocalCronRunReceiptOwnership(entry.runReceipt);
      const launch = pending;
      // The launch owns its lifetime beyond the request acknowledgement and store lock.
      const running = runWithGatewayDetachedWorkContinuation(
        () =>
          Promise.resolve().then(() =>
            runOutsideOperatorToolGatewayAuthority(() => {
              const run = () => launchCronRun(state, entry, launch);
              return state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run();
            }),
          ),
        "cron:run",
      )
        .catch(async (error: unknown) => {
          state.deps.log.error(
            { jobId: entry.job.id, err: String(error) },
            "cron: queued launch failed",
          );
          launch.completion.reject(error);
          try {
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
            launch.completion.reject(error);
            launch.removeCancellation?.();
            launchState(state).contexts.delete(entry.runReceipt.receiptId);
            releaseLocalCronRunReceiptOwnership(entry.runReceipt);
          }
        })
        .finally(() => {
          launchState(state).running.delete(running);
          pumpCronRunQueues(state);
        });
      launchState(state).running.add(running);
    }
  }).finally(() => {
    launchState(state).drain = undefined;
  });
  await launchState(state).drain;
}

async function launchCronRun(
  state: CronServiceState,
  entry: CronQueuedRun,
  pending: CronLaunchContext,
) {
  const { options } = pending;
  await ensureLoaded(state, { forceReload: true });
  pending.context.admission.assertCurrent();
  options.commitGuard?.();
  const current = state.store?.jobs.find((job) => job.id === entry.job.id);
  const force = options.mode === "force" || options.onExit !== undefined;
  const unavailable =
    state.deps.isAgentAvailable?.(entry.runReceipt.agentId, undefined, {
      deletionBlocked: false,
    }) === false;
  // One final live owner/eligibility check; a disable may still race dispatch.
  if (
    state.stopped ||
    pending.generation !== state.lifecycleGeneration ||
    !current ||
    unavailable ||
    current.state.runningReceiptId !== entry.runReceipt.receiptId ||
    (!force && (!isJobEnabled(current) || current.state.autoDisabled)) ||
    (options.streamScheduleKey !== undefined &&
      !ownsStreamSource(current, options.streamScheduleKey, options.streamSourceIdentity ?? ""))
  ) {
    await cancelCronRunRequests(
      state,
      [entry.runReceipt.receiptId],
      unavailable
        ? describeUnavailableCronAgent(entry.runReceipt.agentId)
        : "cron: job became ineligible before launch",
    );
    return;
  }
  const manual = options.source === "manual" || options.source === "event";
  const activeJobMarker = manual
    ? markManualCronJobActive(state, entry.job, entry.runReceipt)
    : markServiceCronJobActive(state, entry.job, entry.runReceipt);
  const admittedJob = structuredClone(entry.job);
  if (options.onExit) {
    admittedJob.enabled = false;
  }
  const executionJob = structuredClone(admittedJob);
  executionJob.payload =
    options.onExit?.payload?.(structuredClone(entry.job)) ??
    options.payload ??
    executionJob.payload;
  if (isImmediateCronRunMode(options.mode)) {
    executionJob.state.nextRunAtMs = options.scheduleOwnershipAtMs;
    executionJob.trigger = options.evaluateTrigger ? executionJob.trigger : undefined;
  }
  const taskRunId = createCronRunHandle({
    state,
    job: entry.job,
    startedAt: entry.runReceipt.startedAtMs,
    runReceipt: entry.runReceipt,
    publicRunId: options.runId,
  }).runId;
  emit(state, {
    jobId: entry.job.id,
    job: entry.job,
    action: "started",
    runAtMs: entry.runReceipt.startedAtMs,
  });
  if (state.stopped || pending.generation !== state.lifecycleGeneration) {
    await cancelCronRunRequests(
      state,
      [entry.runReceipt.receiptId],
      "cron service stopped before execution",
    );
    if (manual) {
      clearManualCronJobActive(state, entry.job.id, activeJobMarker);
    } else {
      clearCronJobActive(entry.job.id, activeJobMarker);
    }
    return;
  }
  pending.removeCancellation?.();
  pending.started = true;
  pending.activation.resolve();
  let result: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
  try {
    result = await executeJobCoreWithTimeout(state, executionJob, {
      runId: taskRunId,
      activeJobMarker,
      streamBatch: options.streamBatch,
      streamScheduleKey: options.streamScheduleKey,
      streamSourceIdentity: options.streamSourceIdentity,
      runReceipt: entry.runReceipt,
      runReceiptContext: pending.context,
      executionIdentity: createCronOwnerExecutionIdentityAdmission({
        state,
        runReceipt: entry.runReceipt,
      }),
    });
  } catch (error) {
    result = authorCronRunCompletion(executionJob, {
      status: "error",
      error: normalizeCronRunErrorText(error),
    });
  }
  options.onTriggerDisposition?.(
    result.triggerEval?.busy
      ? "busy"
      : result.status === "error"
        ? "error"
        : result.status !== "ok"
          ? "dropped"
          : !executionJob.trigger || result.triggerEval?.fired
            ? "fired"
            : "dropped",
  );
  const finalized = await finalizeCompletedCronRunOutcomes(
    state,
    [
      {
        ...result,
        jobId: entry.job.id,
        job: admittedJob,
        taskRunId,
        activeJobMarker,
        runReceipt: entry.runReceipt,
        runReceiptContext: pending.context,
        startedAt: entry.runReceipt.startedAtMs,
        endedAt: state.deps.nowMs(),
        ...(manual
          ? {
              request: {
                executionJob,
                preserveCadence: isImmediateCronRunMode(options.mode),
                scheduleOwnershipAtMs:
                  options.scheduleOwnershipAtMs ?? entry.runReceipt.startedAtMs,
                runId: options.runId,
                terminalTracker: options.runId ? options.terminalTracker : undefined,
              },
            }
          : {}),
      },
    ],
    { discardWhenStopped: true },
  );
  if (!manual && finalized.length && !pending.batch.notified) {
    pending.batch.notified = maybeNotifyIsolatedAgentSetupTimeout(state, {
      ...result,
      jobId: entry.job.id,
      job: executionJob,
    });
  }
  pending.removeCancellation?.();
  pending.completion.resolve({ ok: true, ran: true });
  launchState(state).contexts.delete(entry.runReceipt.receiptId);
}

export async function stopCronRunQueue(state: CronServiceState) {
  await launchState(state).drain;
  const queued = [...launchState(state).contexts.values()].filter(
    ({ receipt }) =>
      state.store?.jobs.find((job) => job.id === receipt.jobId)?.state.runningReceiptId !==
      receipt.receiptId,
  );
  await cancelCronRunRequests(
    state,
    queued.map(({ receipt }) => receipt.receiptId),
    "cron service stopped",
  );
}

export async function waitForCronRunQueue(state: CronServiceState) {
  await launchState(state).drain;
  await Promise.allSettled(launchState(state).running);
}
