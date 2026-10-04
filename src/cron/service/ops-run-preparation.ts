import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronServiceRunOptions } from "../service-contract.js";
import { assertCanonicalCronDeliveryMode } from "../store/delivery-codec.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import { ownsStreamSource } from "../stream-schedule.js";
import type { CronJob, CronPayload } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { findJobOrThrow, hasActiveCronRun, isJobEnabled } from "./jobs-scheduling.js";
import { assertExecutionPolicy, assertSupportedJobSpec } from "./jobs-validation.js";
import { locked } from "./locked.js";
import { markManualCronJobActive } from "./ops-shared.js";
import { releaseReservationOwnership, releaseReservedCronRuns } from "./run-admission-mutation.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  isQueuedCronRunReservationCurrent,
  matchesOnExitSchedule,
  persistQueuedCronRunReservations,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { createCronRunHandle } from "./run-history.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { recordSkippedCronRuns } from "./scheduler-mutations.js";
import type { CronRunMode, CronServiceState } from "./state.js";
import { emit, isImmediateCronRunMode } from "./state.js";
import {
  captureCronServiceMutationSource,
  ensureLoaded,
  runPostPersistCronNotifications,
  warnIfDisabled,
} from "./store.js";
import { emitCronRunFinished, type ManualRunTerminalTracker } from "./timer-outcome-events.js";
import { isRunnableJob } from "./timer-runnable.js";
import { armTimer } from "./timer.js";

export type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason: "already-running" | "disabled" | "not-due" | "invalid-spec" | "stopped" | "ownerless";
    }
  | (ManualRunOptions & {
      ok: true;
      ran: true;
      jobId: string;
      reservationAt: number;
      scheduleOwnershipAtMs: number;
      reservationIdentity: object;
      wasEnabled: boolean;
    })
  | { ok: false };

export type ActivatedManualRun = Extract<PreparedManualRun, { ran: true }> & {
  startedAt: number;
  taskRunId?: string;
  activeJobMarker?: CronActiveJobMarker;
  admittedJob: CronJob;
  executionJob: CronJob;
  runReceipt: CronRunReceiptHandle;
  runReceiptContext: OpenClawStateWorkerContext;
};

export type OnExitRunOptions = {
  schedule: Extract<CronJob["schedule"], { kind: "on-exit" }>;
  signal: AbortSignal;
  commitGuard: () => void;
  onReserved: () => void;
  payload?: (job: CronJob) => CronPayload | undefined;
};

export type ManualRunOptions = {
  onSettledResult?: CronServiceRunOptions["onSettledResult"];
  onExit?: OnExitRunOptions;
  runId?: string;
  /** Revalidates the caller before preflight effects and durable reservation. */
  commitGuard?: () => void;
  scheduleOwnershipAtMs?: number;
  payload?: CronPayload;
  delivery?: CronServiceRunOptions["delivery"];
  terminalTracker?: ManualRunTerminalTracker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  evaluateTrigger?: boolean;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};

type ManualRunDisposition =
  | Extract<PreparedManualRun, { ran: false }>
  | { ok: true; runnable: true };

type ManualRunPreflightResult =
  | { ok: false }
  | Extract<PreparedManualRun, { ran: false }>
  | {
      ok: true;
      runnable: true;
      job: CronJob;
    };

function admitsStreamSourceRun(
  job: CronJob,
  streamScheduleKey?: string,
  streamSourceIdentity?: string,
): boolean {
  if (streamScheduleKey === undefined && streamSourceIdentity === undefined) {
    return true;
  }
  return (
    streamScheduleKey !== undefined &&
    streamSourceIdentity !== undefined &&
    isJobEnabled(job) &&
    ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)
  );
}

async function skipInvalidPersistedManualRun(params: {
  state: CronServiceState;
  source: ReturnType<typeof captureCronServiceMutationSource>;
  job: CronJob;
  mode?: CronRunMode;
  runId?: string;
  commitGuard?: () => void;
  terminalTracker?: ManualRunTerminalTracker;
  error: unknown;
}) {
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
    severity: "warn",
    nowMs: params.state.deps.nowMs,
  });
  await recordSkippedCronRuns({
    state: params.state,
    source: params.source,
    nowMs: endedAt,
    assertCurrent: params.commitGuard,
    change: {
      kind: "invalid-manual",
      jobId: params.job.id,
      configRevision: resolveCronJobConfigRevision(params.job),
      error: errorText,
      diagnostics,
      scheduleMode: isImmediateCronRunMode(params.mode) ? "preserve" : "advance",
    },
    async afterCommit(outcome, historySource) {
      const job = outcome.jobs[0];
      if (!job) {
        armTimer(params.state);
        return;
      }
      applyCronRuntimeRowsToState(params.state, [job]);
      for (const entry of outcome.logs) {
        params.state.deps.log[entry.level](entry.fields, entry.message);
      }
      await emitCronRunFinished(
        params.state,
        {
          jobId: job.id,
          action: "finished",
          job,
          status: "skipped",
          error: errorText,
          diagnostics,
          runId: params.runId,
          runAtMs: endedAt,
          durationMs: job.state.lastDurationMs,
          nextRunAtMs: job.state.nextRunAtMs,
          deliveryStatus: job.state.lastDeliveryStatus,
          deliveryError: job.state.lastDeliveryError,
          failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
        },
        params.terminalTracker,
        undefined,
        { historySource },
      );
      for (const notification of outcome.notifications) {
        historySource.assertCurrent();
        runPostPersistCronNotifications(params.state, [notification]);
      }
      historySource.assertCurrent();
      armTimer(params.state);
    },
  });
}

async function recomputeManualRunPreflight(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
) {
  await recomputeUnownedCronSchedules(state, {
    ...(isImmediateCronRunMode(mode) ? { preserveExpiredPacedNextRunJobId: id } : {}),
    skipScheduleErrorHandling: true,
  });
}

// The caller holds the store lock through preflight and any reservation.
async function inspectManualRunPreflight(
  state: CronServiceState,
  id: string,
  source: ReturnType<typeof captureCronServiceMutationSource>,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
): Promise<ManualRunPreflightResult> {
  warnIfDisabled(state, "run");
  if (state.stopped) {
    return { ok: true, ran: false, reason: "stopped" };
  }
  source.assertCurrent();
  await ensureLoaded(state);
  source.assertCurrent();
  opts?.commitGuard?.();
  if (state.stopped) {
    return { ok: true, ran: false, reason: "stopped" };
  }
  // Normalize stale tick state before eligibility checks (#17554). Revalidate
  // after notifications too: synchronous owner callbacks can close the caller.
  await recomputeManualRunPreflight(state, id, mode);
  opts?.commitGuard?.();
  if (state.stopped) {
    return { ok: true, ran: false, reason: "stopped" };
  }
  const job = opts?.onExit
    ? state.store?.jobs.find((entry) => entry.id === id)
    : findJobOrThrow(state, id);
  if (!job || (opts?.onExit && !matchesOnExitSchedule(job, opts.onExit.schedule))) {
    return { ok: true, ran: false, reason: "not-due" };
  }
  assertCanonicalCronDeliveryMode(job.delivery);
  if (opts?.onExit && (!isJobEnabled(job) || job.state.autoDisabled)) {
    return { ok: true, ran: false, reason: "disabled" };
  }
  if (mode === "if-enabled" && (!isJobEnabled(job) || job.state.autoDisabled)) {
    return { ok: true, ran: false, reason: "disabled" };
  }
  if (!admitsStreamSourceRun(job, opts?.streamScheduleKey, opts?.streamSourceIdentity)) {
    return { ok: true, ran: false, reason: "not-due" };
  }
  try {
    assertSupportedJobSpec(job);
  } catch (error) {
    await skipInvalidPersistedManualRun({
      state,
      job,
      mode,
      source,
      runId: opts?.runId,
      commitGuard: opts?.commitGuard ?? opts?.onExit?.commitGuard,
      terminalTracker: opts?.terminalTracker,
      error,
    });
    return { ok: true, ran: false, reason: "invalid-spec" };
  }
  if (hasActiveCronRun(job)) {
    return { ok: true, ran: false, reason: "already-running" };
  }
  const now = state.deps.nowMs();
  if (
    !isRunnableJob({
      job,
      nowMs: now,
      forced: isImmediateCronRunMode(mode),
    })
  ) {
    return { ok: true, ran: false, reason: "not-due" };
  }
  return { ok: true, runnable: true, job };
}

export async function inspectManualRunDisposition(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: Pick<ManualRunOptions, "commitGuard">,
): Promise<ManualRunDisposition | { ok: false }> {
  // Reject ineligible requests before root admission; prepareManualRun rechecks
  // under lock before reserving eligible work for the command lane.
  const source = captureCronServiceMutationSource(state);
  const result = await locked(state, () =>
    inspectManualRunPreflight(state, id, source, mode, opts),
  );
  if (!result.ok) {
    return result;
  }
  if ("reason" in result) {
    return result;
  }
  return { ok: true, runnable: true } as const;
}

export async function prepareManualRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
): Promise<PreparedManualRun> {
  const source = captureCronServiceMutationSource(state);
  return await locked(state, async () => {
    const generation = state.lifecycleGeneration;
    const preflight = await inspectManualRunPreflight(state, id, source, mode, opts);
    if (!preflight.ok || "reason" in preflight) {
      return preflight;
    }
    if (state.lifecycleGeneration !== generation) {
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    const { job } = preflight;
    // Preflight awaited store loading; keep the exact caller live until the
    // reservation worker transfers ownership to its durable receipt.
    opts?.commitGuard?.();
    const reservationAt = state.deps.nowMs();
    if (
      !isRunnableJob({
        job,
        nowMs: reservationAt,
        forced: isImmediateCronRunMode(mode),
      })
    ) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    // Direct run() callers also need to distinguish an ownerless result from a busy job.
    const internalTracker = opts?.terminalTracker ?? { emitted: false };
    const onExit = opts?.onExit;
    let reservationIdentity: object | undefined;
    let reserved: Awaited<ReturnType<typeof persistQueuedCronRunReservations>>[number] | undefined;
    try {
      [reserved] = await persistQueuedCronRunReservations({
        state,
        candidates: [job],
        source,
        ...(isImmediateCronRunMode(mode) ? { immediateJobIds: new Set([job.id]) } : {}),
        reservedAtMs: reservationAt,
        ...(isImmediateCronRunMode(mode) ? { scheduleMode: "preserve" as const } : {}),
        manualRun: {
          runId: opts?.runId,
          commitGuard: opts?.commitGuard,
          terminalTracker: internalTracker,
          scheduleOwnershipAtMs: opts?.scheduleOwnershipAtMs,
          ...(onExit
            ? {
                onExit: {
                  commitGuard: onExit.commitGuard,
                  onReserved: (reservedJob, runReceipt, runReceiptContext) => {
                    reservationIdentity = reserveQueuedCronRun(
                      state,
                      reservedJob.id,
                      reservationAt,
                      {
                        runReceipt,
                        runReceiptContext,
                        preserveWhenDisabled: true,
                        onExit: true,
                        lifecycleGeneration: generation,
                      },
                    );
                    onExit.onReserved();
                  },
                },
              }
            : {}),
        },
      });
    } catch (error) {
      if (reservationIdentity) {
        await releasePreparedManualReservationWithRetry(state, {
          jobId: job.id,
          reservationIdentity,
        });
      }
      throw error;
    }
    if (!reserved) {
      if (state.stopped || state.lifecycleGeneration !== generation) {
        return { ok: true, ran: false, reason: "stopped" as const };
      }
      if (internalTracker.emitted) {
        return { ok: true, ran: false, reason: "ownerless" as const };
      }
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const reservedJob = reserved.job;
    reservationIdentity ??= reserveQueuedCronRun(state, reservedJob.id, reservationAt, {
      runReceipt: reserved.runReceipt,
      runReceiptContext: reserved.runReceiptContext,
      preserveWhenDisabled: mode === "force" && !isJobEnabled(job),
      lifecycleGeneration: generation,
    });
    if (state.stopped || state.lifecycleGeneration !== generation) {
      try {
        await releasePreparedManualReservationWithRetry(state, {
          jobId: reservedJob.id,
          reservationIdentity,
        });
      } catch (error) {
        releaseQueuedCronRun(state, job.id, reservationIdentity);
        throw error;
      }
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    return {
      ok: true,
      ran: true,
      jobId: reservedJob.id,
      runId: opts?.runId,
      terminalTracker: opts?.terminalTracker,
      onSettledResult: opts?.onSettledResult,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      commitGuard: opts?.commitGuard,
      reservationAt,
      scheduleOwnershipAtMs: opts?.scheduleOwnershipAtMs ?? reservationAt,
      reservationIdentity,
      wasEnabled: opts?.onExit ? false : isJobEnabled(job),
      ...(onExit ? { onExit } : {}),
      ...(opts?.payload ? { payload: structuredClone(opts.payload) } : {}),
      ...(opts?.delivery ? { delivery: structuredClone(opts.delivery) } : {}),
      ...(opts?.evaluateTrigger ? { evaluateTrigger: true } : {}),
      ...(opts?.streamBatch !== undefined ? { streamBatch: opts.streamBatch } : {}),
      ...(opts?.streamScheduleKey !== undefined
        ? { streamScheduleKey: opts.streamScheduleKey }
        : {}),
      ...(opts?.streamSourceIdentity !== undefined
        ? { streamSourceIdentity: opts.streamSourceIdentity }
        : {}),
      ...(opts?.onTriggerDisposition ? { onTriggerDisposition: opts.onTriggerDisposition } : {}),
    } as const;
  });
}

export async function activatePreparedManualRun(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
  mode?: CronRunMode,
): Promise<ActivatedManualRun | Extract<PreparedManualRun, { ran: false }>> {
  const source = captureCronServiceMutationSource(
    state,
    state.queuedRunReservationsByJobId.get(prepared.jobId)?.runReceiptContext,
  );
  return await locked(state, async () => {
    // Reservations can wait behind another cron run. Reload under the service
    // lock so disabling, rescheduling, or removing the job wins that wait.
    await ensureLoaded(state, { forceReload: true });
    prepared.commitGuard?.();
    prepared.onExit?.commitGuard();
    if (state.stopped) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    const job = state.store?.jobs.find((entry) => entry.id === prepared.jobId);
    if (!job) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    if (mode === "if-enabled" && (!isJobEnabled(job) || job.state.autoDisabled)) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "disabled" } as const;
    }
    if (
      !isQueuedCronRunReservationCurrent(state, prepared.jobId, prepared.reservationIdentity) ||
      job.state.queuedAtMs !== prepared.reservationAt
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    if (prepared.onExit && !matchesOnExitSchedule(job, prepared.onExit.schedule)) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" };
    }
    if (!admitsStreamSourceRun(job, prepared.streamScheduleKey, prepared.streamSourceIdentity)) {
      // This is reservation identity, not watcher ownership: a force run can
      // wait behind cron admission after its owner has stopped for replacement.
      // The logical source identity rejects retired batches even when the
      // schedule key is unchanged (disable→re-enable, A→B→A).
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    const dueProbe = structuredClone(job);
    delete dueProbe.state.queuedAtMs;
    if (
      (prepared.wasEnabled && !isJobEnabled(job)) ||
      !isRunnableJob({
        job: dueProbe,
        nowMs: state.deps.nowMs(),
        forced: isImmediateCronRunMode(mode),
      })
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({
        state,
        job,
        mode,
        source,
        runId: prepared.runId,
        commitGuard: prepared.commitGuard ?? prepared.onExit?.commitGuard,
        terminalTracker: prepared.terminalTracker,
        error,
      });
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "invalid-spec" } as const;
    }

    let delivery = job.delivery;
    if (prepared.delivery) {
      const configured = job.delivery;
      delivery = {
        mode: "announce",
        ...configured,
        ...prepared.delivery,
        // Routing cannot widen the persisted account, owner, or silent policy.
        ...(configured?.target === "owner"
          ? { target: "owner", to: undefined, threadId: undefined }
          : {}),
        ...(configured?.accountId ? { accountId: configured.accountId } : {}),
        ...(configured?.mode === "none" ? { mode: "none" } : {}),
      };
      assertExecutionPolicy({ ...job, delivery });
    }
    const activation = await activateQueuedCronRun({
      state,
      job,
      reservationIdentity: prepared.reservationIdentity,
      commitGuard: prepared.commitGuard ?? prepared.onExit?.commitGuard,
      onExitSchedule: prepared.onExit?.schedule,
      onUnavailableRollbackError: async () => {
        await releasePreparedManualReservationWithRetry(state, prepared);
      },
    });
    if (activation.kind === "unavailable") {
      return { ok: true, ran: false, reason: activation.reason } as const;
    }
    if (activation.kind === "fenced") {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "already-running" } as const;
    }
    prepared.onExit?.commitGuard();
    const { job: activatedJob, startedAt } = activation;
    const payload = prepared.onExit?.payload?.(structuredClone(activatedJob)) ?? prepared.payload;
    emit(state, {
      jobId: activatedJob.id,
      action: "started",
      job: activatedJob,
      runAtMs: startedAt,
    });
    const taskRun = createCronRunHandle({
      state,
      job: activatedJob,
      startedAt,
      runReceipt: activation.runReceipt,
      publicRunId: prepared.runId,
    });
    const taskRunId = taskRun?.runId;
    const activeJobMarker = markManualCronJobActive(state, activatedJob, activation.runReceipt);
    // Immediate delivery belongs to the accepted request, not an old timed slot.
    // Keep execution overrides separate from the admitted cadence and trigger.
    const admittedJob = structuredClone(activatedJob);
    if (prepared.onExit) {
      // This invocation consumed the disabled arm at reservation. A queued
      // re-enable belongs to its successor, including delete-after-run policy.
      admittedJob.enabled = false;
    }
    const executionJob = structuredClone({
      ...activatedJob,
      payload: payload ?? activatedJob.payload,
      ...(prepared.delivery ? { delivery } : {}),
    });
    if (isImmediateCronRunMode(mode)) {
      executionJob.state.nextRunAtMs = prepared.scheduleOwnershipAtMs;
      executionJob.trigger = prepared.evaluateTrigger ? executionJob.trigger : undefined;
    }
    return {
      ...prepared,
      startedAt,
      runId: prepared.runId ?? taskRunId,
      taskRunId,
      activeJobMarker,
      admittedJob,
      executionJob,
      runReceipt: activation.runReceipt,
      runReceiptContext: activation.runReceiptContext,
    } as const;
  });
}

async function releasePreparedManualReservation(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
  onSettled: (outcome: "committed" | "not-committed" | "unknown") => void,
): Promise<void> {
  const owner = state.queuedRunReservationsByJobId.get(prepared.jobId);
  if (owner?.identity !== prepared.reservationIdentity) {
    onSettled("not-committed");
    return;
  }
  await releaseReservedCronRuns({
    state,
    context: owner.runReceiptContext,
    storeKey: owner.runReceipt.storeKey,
    reservations: [prepared],
    policy: { kind: "manual-abandon" },
    onSettled,
  });
}

export async function releasePreparedManualReservationWithRetry(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
): Promise<void> {
  let retrySafe = false;
  const attempt = async () => {
    retrySafe = false;
    await releasePreparedManualReservation(state, prepared, (outcome) => {
      retrySafe = outcome === "not-committed";
    });
  };
  try {
    await attempt();
  } catch (error) {
    try {
      if (!retrySafe) {
        throw error;
      }
      await attempt();
    } catch (failure) {
      // Native work has settled. Leave uncertain durable markers for the existing recovery owner.
      releaseReservationOwnership(state, [prepared]);
      throw failure;
    }
  }
}

export async function releasePreparedManualReservationAfterReloadWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  await cleanupQueuedCronRunReservations({
    state,
    reservations: [prepared],
    restoreLastError: false,
  });
}
