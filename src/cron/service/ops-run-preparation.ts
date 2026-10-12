import { resolveCronJobConfigRevision } from "../config-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { assertCanonicalCronDeliveryMode } from "../store/delivery-codec.js";
import type { InterruptedStartupRun } from "../store/run-recovery.types.js";
import { ownsStreamSource } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { enrollForeignReceipt, removeForeignReceipt } from "./foreign-receipt-monitor.js";
import { findJobOrThrow, hasActiveCronRun, isJobEnabled } from "./jobs-scheduling.js";
import { assertSupportedJobSpec } from "./jobs-validation.js";
import type { ManualRunOptions } from "./run-options.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { recordSkippedCronRuns } from "./scheduler-mutations.js";
import type { CronRunMode, CronServiceState } from "./state.js";
import { isImmediateCronRunMode } from "./state.js";
import {
  captureCronServiceMutationSource,
  ensureLoaded,
  runPostPersistCronNotifications,
  warnIfDisabled,
} from "./store.js";
import { emitCronRunFinished } from "./timer-outcome-events.js";
import { isRunnableJob } from "./timer-runnable.js";
import { armTimer } from "./timer.js";

type ManualRunSkipped = {
  ok: true;
  ran: false;
  reason: "already-running" | "disabled" | "not-due" | "invalid-spec" | "stopped" | "ownerless";
};

type ManualRunPreflightResult =
  | { ok: false }
  | ManualRunSkipped
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
  terminalTracker?: { emitted: boolean };
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
        await runPostPersistCronNotifications(params.state, [notification]);
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

async function recoverManualRunPreflight(state: CronServiceState, id: string): Promise<void> {
  const job = state.store?.jobs.find((entry) => entry.id === id);
  const interrupted: InterruptedStartupRun[] = [];
  let repaired = false;
  try {
    await recoverCronRunProposals(
      state,
      [
        {
          jobId: id,
          queuedAtMs: job?.state.queuedAtMs,
          runningAtMs: job?.state.runningAtMs,
          runningReceiptId: job?.state.runningReceiptId,
        },
      ],
      {
        async onRecovery(_proposal, result) {
          if (result.kind === "repaired") {
            repaired = true;
            removeForeignReceipt(state, id);
            await runPostPersistCronNotifications(state, result.notifications);
            if (result.interrupted) {
              interrupted.push(result.interrupted);
            }
          } else if (result.receipt && result.receipt.ownerPid !== process.pid) {
            enrollForeignReceipt(state, result.receipt);
          }
        },
      },
    );
  } finally {
    if (repaired) {
      await ensureLoaded(state, { forceReload: true });
    }
    for (const result of interrupted) {
      await emitInterruptedCronRun(state, result);
    }
  }
}

// The caller holds the store lock through preflight and request submission.
export async function inspectManualRunPreflight(
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
  await ensureLoaded(state, { forceReload: true });
  source.assertCurrent();
  opts?.commitGuard?.();
  if (state.stopped) {
    return { ok: true, ran: false, reason: "stopped" };
  }
  await recoverManualRunPreflight(state, id);
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
  if (
    !job ||
    (opts?.onExit &&
      (job.schedule.kind !== "on-exit" ||
        job.schedule.command !== opts.onExit.schedule.command ||
        job.schedule.cwd !== opts.onExit.schedule.cwd))
  ) {
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
