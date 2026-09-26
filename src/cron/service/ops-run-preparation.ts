import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { resolveCronCompletionStatus } from "../completion-status.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import {
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type {
  CronFailureNotificationDetail,
  CronJob,
  CronPayload,
  CronRunErrorClassification,
} from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { findJobOrThrow, hasActiveCronRun, isJobDue, isJobEnabled } from "./jobs-scheduling.js";
import { assertSupportedJobSpec } from "./jobs-validation.js";
import { locked } from "./locked.js";
import { markManualCronJobActive, ownsStreamSource } from "./ops-shared.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  isQueuedCronRunReservationCurrent,
  matchesOnExitSchedule,
  persistQueuedCronRunReservations,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { createCronRunHandle, finishCronRun } from "./run-history.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import type {
  CronEvent,
  CronRunMode,
  CronServiceState,
  DeferredCronNotifications,
} from "./state.js";
import { cronFailureNotificationEventContext, emit, isImmediateCronRunMode } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications, warnIfDisabled } from "./store.js";
import { applyJobResult, armTimer, type CronTriggerEvalOutcome } from "./timer.js";

export type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason: "already-running" | "disabled" | "not-due" | "invalid-spec" | "stopped" | "ownerless";
    }
  | {
      ok: true;
      ran: true;
      jobId: string;
      runId?: string;
      terminalTracker?: ManualRunTerminalTracker;
      owningCronLaneTaskMarker?: CommandLaneTaskMarker;
      commitGuard?: () => void;
      reservationAt: number;
      scheduleOwnershipAtMs: number;
      reservationIdentity: object;
      wasEnabled: boolean;
      onExit?: OnExitRunOptions;
      payload?: CronPayload;
      evaluateTrigger?: boolean;
      streamBatch?: string;
      streamScheduleKey?: string;
      streamSourceIdentity?: string;
      onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
    }
  | { ok: false };

export type ActivatedManualRun = Extract<PreparedManualRun, { ran: true }> & {
  startedAt: number;
  taskRunId?: string;
  activeJobMarker?: CronActiveJobMarker;
  admittedJob: CronJob;
  executionJob: CronJob;
  runReceipt: CronRunReceiptHandle;
};

export type OnExitRunOptions = {
  schedule: Extract<CronJob["schedule"], { kind: "on-exit" }>;
  signal: AbortSignal;
  commitGuard: () => void;
  onReserved: () => void;
  payload?: (job: CronJob) => CronPayload | undefined;
};

export type ManualRunOptions = {
  onExit?: OnExitRunOptions;
  runId?: string;
  /** Revalidates the caller before preflight effects and durable reservation. */
  commitGuard?: () => void;
  scheduleOwnershipAtMs?: number;
  payload?: CronPayload;
  terminalTracker?: ManualRunTerminalTracker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  evaluateTrigger?: boolean;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};

export type ManualRunTerminalTracker = { emitted: boolean };

export async function emitCronRunFinished(
  state: CronServiceState,
  evt: CronEvent & { action: "finished" },
  tracker?: ManualRunTerminalTracker,
  taskRunId?: string,
  details?: {
    triggerEval?: CronTriggerEvalOutcome;
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
    errorClassification?: CronRunErrorClassification;
    failureNotificationDetail?: CronFailureNotificationDetail;
  },
): Promise<void> {
  const event = {
    ...evt,
    completionStatus:
      evt.completionStatus ??
      resolveCronCompletionStatus({ status: evt.status, deliveryStatus: evt.deliveryStatus }),
  };
  await finishCronRun(state, {
    taskRunId,
    job: evt.job,
    event,
    errorClassification: details?.errorClassification,
    ...(details?.scriptResult ? { scriptResult: details.scriptResult } : {}),
    ...(details?.triggerEval ? { triggerEval: details.triggerEval } : {}),
  });
  emit(state, event, cronFailureNotificationEventContext(details?.failureNotificationDetail));
  if (tracker) {
    tracker.emitted = true;
  }
}

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
  job: CronJob;
  mode?: CronRunMode;
  runId?: string;
  terminalTracker?: ManualRunTerminalTracker;
  error: unknown;
}) {
  const postPersistNotifications: DeferredCronNotifications = [];
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
    severity: "warn",
    nowMs: params.state.deps.nowMs,
  });
  // Applying the outcome may disable a one-shot; compare the original definition.
  const configRevision = resolveCronJobConfigRevision(params.job);
  applyJobResult(
    params.state,
    params.job,
    {
      status: "skipped",
      completionStatus: "failed",
      error: errorText,
      diagnostics,
      startedAt: endedAt,
      endedAt,
    },
    {
      scheduleMode: isImmediateCronRunMode(params.mode) ? "preserve" : "advance",
      deferredNotifications: postPersistNotifications,
    },
  );

  const committedJob = commitCronRuntimeRows({
    state: params.state,
    jobIds: [params.job.id],
    operationLabel: "cron.invalid-manual-run",
    mutate: ({ jobs }) => {
      const current = jobs.get(params.job.id);
      if (!current || resolveCronJobConfigRevision(current) !== configRevision) {
        return { value: undefined };
      }
      current.enabled = params.job.enabled;
      current.updatedAtMs = params.job.updatedAtMs;
      current.state = structuredClone(params.job.state);
      return { upsertJobIds: [current.id], value: current };
    },
  });
  if (!committedJob) {
    armTimer(params.state);
    return;
  }
  // Subscribers may close caller authority or edit the job synchronously.
  // Publish only after the terminal state is durably committed.
  applyCronRuntimeRowsToState(params.state, [committedJob]);
  await emitCronRunFinished(
    params.state,
    {
      jobId: params.job.id,
      action: "finished",
      job: params.job,
      status: "skipped",
      error: errorText,
      diagnostics,
      runId: params.runId,
      runAtMs: endedAt,
      durationMs: params.job.state.lastDurationMs,
      nextRunAtMs: params.job.state.nextRunAtMs,
      deliveryStatus: params.job.state.lastDeliveryStatus,
      deliveryError: params.job.state.lastDeliveryError,
      failureNotificationDelivery: failureNotificationDeliveryFromJobState(params.job),
    },
    params.terminalTracker,
  );
  runPostPersistCronNotifications(params.state, postPersistNotifications);
  armTimer(params.state);
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
  mode?: CronRunMode,
  opts?: ManualRunOptions,
): Promise<ManualRunPreflightResult> {
  warnIfDisabled(state, "run");
  await ensureLoaded(state);
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
      runId: opts?.runId,
      terminalTracker: opts?.terminalTracker,
      error,
    });
    return { ok: true, ran: false, reason: "invalid-spec" };
  }
  if (hasActiveCronRun(job)) {
    return { ok: true, ran: false, reason: "already-running" };
  }
  const now = state.deps.nowMs();
  if (!isJobDue(job, now, { forced: isImmediateCronRunMode(mode) })) {
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
  const result = await locked(state, () => inspectManualRunPreflight(state, id, mode, opts));
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
  return await locked(state, async () => {
    const preflight = await inspectManualRunPreflight(state, id, mode, opts);
    if (!preflight.ok || "reason" in preflight) {
      return preflight;
    }
    const { job } = preflight;
    // Preflight awaited store loading; keep the exact caller live until the
    // synchronous reservation write transfers ownership to its durable receipt.
    opts?.commitGuard?.();
    const reservationAt = state.deps.nowMs();
    if (!isJobDue(job, reservationAt, { forced: isImmediateCronRunMode(mode) })) {
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
                  onReserved: (reservedJob: CronJob, runReceipt: CronRunReceiptHandle) => {
                    reservationIdentity = reserveQueuedCronRun(
                      state,
                      reservedJob.id,
                      reservationAt,
                      {
                        runReceipt,
                        preserveWhenDisabled: true,
                        onExit: true,
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
      if (internalTracker.emitted) {
        return { ok: true, ran: false, reason: "ownerless" as const };
      }
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const reservedJob = reserved.job;
    reservationIdentity ??= reserveQueuedCronRun(state, reservedJob.id, reservationAt, {
      runReceipt: reserved.runReceipt,
      preserveWhenDisabled: mode === "force" && !isJobEnabled(job),
    });
    if (state.stopped) {
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
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      commitGuard: opts?.commitGuard,
      reservationAt,
      scheduleOwnershipAtMs: opts?.scheduleOwnershipAtMs ?? reservationAt,
      reservationIdentity,
      wasEnabled: opts?.onExit ? false : isJobEnabled(job),
      ...(onExit ? { onExit } : {}),
      ...(opts?.payload ? { payload: structuredClone(opts.payload) } : {}),
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
      !isJobDue(dueProbe, state.deps.nowMs(), { forced: isImmediateCronRunMode(mode) })
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
        runId: prepared.runId,
        terminalTracker: prepared.terminalTracker,
        error,
      });
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "invalid-spec" } as const;
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
    } as const;
  });
}

async function releasePreparedManualReservation(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
): Promise<void> {
  if (
    state.queuedRunReservationsByJobId.get(prepared.jobId)?.identity !==
    prepared.reservationIdentity
  ) {
    return;
  }
  const committedJob = commitCronRuntimeRows({
    state,
    jobIds: [prepared.jobId],
    operationLabel: "cron.manual-reservation-cleanup",
    mutate: ({ database, jobs, receiptSchema }) => {
      const job = jobs.get(prepared.jobId);
      const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
      if (ownership?.identity !== prepared.reservationIdentity) {
        return { value: undefined };
      }
      finishCronRunReceiptInDatabase({
        receiptSchema,
        database,
        handle: ownership.runReceipt,
        status: "skipped",
        finishedAtMs: state.deps.nowMs(),
        error: "cron manual reservation abandoned before completion",
      });
      if (!job) {
        return { value: undefined };
      }
      const queuedMatches = ownership.markerAtMs === job.state.queuedAtMs;
      const runningMatches = ownership.markerAtMs === job.state.runningAtMs;
      if (!queuedMatches && !runningMatches) {
        return { value: undefined };
      }
      if (ownership.activationPreviousLastError) {
        job.state.lastError = ownership.activationPreviousLastError.value;
      }
      if (queuedMatches) {
        delete job.state.queuedAtMs;
      }
      if (runningMatches) {
        delete job.state.runningAtMs;
        delete job.state.runningReceiptId;
        delete job.state.runningScheduleChangeId;
      }
      return { upsertJobIds: [job.id], value: job };
    },
  });
  if (committedJob) {
    applyCronRuntimeRowsToState(state, [committedJob]);
  }
  const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
  if (ownership?.identity === prepared.reservationIdentity) {
    releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
  }
  releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
}

export async function releasePreparedManualReservationWithRetry(
  state: CronServiceState,
  prepared: Pick<Extract<PreparedManualRun, { ran: true }>, "jobId" | "reservationIdentity">,
): Promise<void> {
  try {
    await releasePreparedManualReservation(state, prepared);
  } catch {
    try {
      await releasePreparedManualReservation(state, prepared);
    } catch (error) {
      // No caller owns another retry. Let stale-marker recovery see the
      // durable marker instead of retaining a process-only queued claim.
      const ownership = state.queuedRunReservationsByJobId.get(prepared.jobId);
      if (ownership?.identity === prepared.reservationIdentity) {
        releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
      }
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
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
