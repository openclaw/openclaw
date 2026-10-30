import type { EngineConnection } from "../../infra/sql-connection.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { STARTUP_INTERRUPTED_ERROR } from "../execution-error-constants.js";
import { cronRunLogEntryToDetail } from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import { failureNotificationDeliveryFromJobState } from "../service/failure-alerts.js";
import {
  isJobEnabled,
  recomputeJobNextRunAtMs,
  resolveCronRestartRetryAtMs,
} from "../service/jobs-scheduling.js";
import { resolveForcePreservedOneShotAtMs } from "../service/one-shot-schedule.js";
import { findCronRunRecoveryInDatabase } from "../service/run-history-recovery.js";
import { resolveCronRunReceiptTerminalStatus } from "../service/run-receipts.js";
import {
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
} from "../service/startup-run-repair.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "../service/state.js";
import type { CronJob } from "../types.js";
import { deleteCronJobRowInDatabase, updateCronRuntimeRow } from "./row-codec.js";
import {
  recordCronRunInDatabase,
  recordSkippedCronRequestInDatabase,
} from "./run-history.kernel.js";
import { finishCronRunReceiptInDatabase } from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRunReceipt } from "./run-receipt.types.js";
import type { InterruptedStartupRun } from "./run-recovery.types.js";
import { parseCronScheduledRunId } from "./run-request-id.js";

function recordInterruptedRun(params: {
  database: EngineConnection;
  storeKey: string;
  interrupted: InterruptedStartupRun;
  nowMs: number;
  job?: CronJob;
  receipt?: CronRunReceipt;
  taskRunId?: string;
}): InterruptedStartupRun {
  const { database, storeKey, job, receipt, nowMs } = params;
  const publicRunId = receipt?.requestRunId?.trim();
  const interrupted = { ...params.interrupted, ...(publicRunId ? { runId: publicRunId } : {}) };
  const prefix = createCronExecutionId(interrupted.jobId, interrupted.runAtMs);
  const runId = params.taskRunId ?? `${prefix}:${receipt?.receiptId ?? "interrupted"}`;
  recordCronRunInDatabase(database, {
    storeKey,
    jobId: interrupted.jobId,
    runId,
    agentId: receipt?.agentId ?? job?.agentId,
    startedAt: interrupted.runAtMs,
    endedAt: nowMs,
    status: "failed",
    error: STARTUP_INTERRUPTED_ERROR,
    detail: cronRunLogEntryToDetail(
      {
        ts: nowMs,
        jobId: interrupted.jobId,
        action: "finished",
        status: "error",
        completionStatus: "failed",
        error: STARTUP_INTERRUPTED_ERROR,
        delivered: false,
        deliveryStatus: "unknown",
        deliveryError: STARTUP_INTERRUPTED_ERROR,
        failureNotificationDelivery: job ? failureNotificationDeliveryFromJobState(job) : undefined,
        runId: interrupted.runId,
        runAtMs: interrupted.runAtMs,
        durationMs: interrupted.durationMs,
        nextRunAtMs: job?.state.nextRunAtMs,
      },
      { storeKey },
    ),
  });
  return interrupted;
}

/** Startup owns abandoned rows; there is no live foreign Cron owner to negotiate with. */
export function recoverCronJobInDatabase(
  params: {
    state: CronJobPolicyContext;
    storeKey: string;
    database: OpenClawStateDatabase;
    receiptSchema: CronRunReceiptWriteSchema;
    notifications: DeferredCronNotifications;
  } & ({ job: CronJob; receipt?: CronRunReceipt } | { job?: undefined; receipt: CronRunReceipt }),
): { removed?: true; interrupted?: InterruptedStartupRun; skipStartupCatchup?: true } {
  const { state, database, storeKey, job, receipt, notifications } = params;
  const nowMs = state.deps.nowMs();
  const pendingReceiptId =
    job?.state.runningAtMs === undefined ? undefined : job.state.runningReceiptId;
  const finishReceipt = (
    status: Exclude<CronRunReceipt["status"], "running">,
    atMs: number,
    error?: string,
  ) => {
    if (receipt) {
      finishCronRunReceiptInDatabase({
        database: database.db,
        receiptSchema: params.receiptSchema,
        handle: receipt,
        pendingReceiptId,
        status,
        finishedAtMs: atMs,
        error,
      });
    }
  };
  if (!job) {
    const task = findCronRunRecoveryInDatabase({
      database: database.db,
      storeKey,
      jobId: receipt.jobId,
      startedAt: receipt.startedAtMs,
      receiptId: receipt.receiptId,
    });
    if (task.finalized) {
      finishReceipt(
        resolveCronRunReceiptTerminalStatus(
          task.finalized.entry.status,
          task.finalized.triggerEval?.fired,
        ),
        task.finalized.entry.ts,
        task.finalized.entry.error,
      );
      return {};
    }
    const interrupted = recordInterruptedRun({
      database: database.db,
      storeKey,
      receipt,
      taskRunId: task.taskRunId,
      nowMs,
      interrupted: {
        jobId: receipt.jobId,
        runAtMs: receipt.startedAtMs,
        durationMs: Math.max(0, nowMs - receipt.startedAtMs),
      },
    });
    finishReceipt("interrupted", nowMs, STARTUP_INTERRUPTED_ERROR);
    return { interrupted };
  }
  const previousEnabled = job.enabled ?? true;
  const runningAtMs = job.state.runningAtMs;
  if (runningAtMs === undefined) {
    if (job.state.queuedAtMs !== undefined) {
      const timed = receipt && parseCronScheduledRunId(receipt.receiptId);
      if (timed && timed.storeKey === storeKey && timed.jobId === job.id && isJobEnabled(job)) {
        return {};
      }
      const error = "cron: queued request lost its launch context";
      recordSkippedCronRequestInDatabase(database.db, {
        storeKey,
        jobId: job.id,
        receiptId: receipt?.receiptId,
        agentId: receipt?.agentId,
        startedAt: job.state.queuedAtMs,
        endedAt: nowMs,
        error,
        nextRunAtMs: job.state.nextRunAtMs,
      });
      delete job.state.queuedAtMs;
      finishReceipt("skipped", nowMs, error);
      updateCronRuntimeRow(database.db, storeKey, job, previousEnabled);
    } else {
      finishReceipt("interrupted", nowMs, "cron: owner unavailable after run marker retirement");
    }
    return {};
  }

  const task = findCronRunRecoveryInDatabase({
    database: database.db,
    jobId: job.id,
    startedAt: runningAtMs,
    storeKey,
    receiptId: job.state.runningReceiptId ?? receipt?.receiptId,
  });
  const receiptId = job.state.runningReceiptId ?? receipt?.receiptId ?? task.receiptId;
  // Only the matching manual receipt can borrow a separate authored occurrence.
  const preservedOccurrenceAtMs =
    receipt?.receiptId === pendingReceiptId &&
    receipt?.startedAtMs === runningAtMs &&
    !parseCronScheduledRunId(receipt.receiptId)
      ? resolveForcePreservedOneShotAtMs(job)
      : undefined;
  const finalized = task.finalized;
  const restored = finalized
    ? restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs,
        preservedOccurrenceAtMs,
        entry: finalized.entry,
        triggerStateRetired: receiptId
          ? isCronRunTriggerStateRetiredInDatabase({
              database: database.db,
              handle: { receiptId, storeKey, jobId: job.id, startedAtMs: runningAtMs },
            })
          : false,
        scriptResult: finalized.scriptResult,
        triggerEval: finalized.triggerEval,
        deferredNotifications: notifications,
      })
    : undefined;
  let interrupted: InterruptedStartupRun | undefined;
  if (!restored) {
    interrupted = markInterruptedStartupRun({
      state,
      job,
      runningAtMs,
      preservedOccurrenceAtMs,
      nowMs,
      restartRetryAtMs:
        receipt &&
        parseCronScheduledRunId(receipt.receiptId) &&
        receipt.deliveryNotStarted === true &&
        receipt.configRevision === resolveCronJobConfigRevision(job) &&
        !job.state.runningScheduleChangeId
          ? resolveCronRestartRetryAtMs(job, runningAtMs, nowMs)
          : undefined,
    });
    if (job.enabled && job.state.nextRunAtMs === undefined) {
      recomputeJobNextRunAtMs({ state, job, nowMs, deferredNotifications: notifications });
    }
    interrupted = recordInterruptedRun({
      database: database.db,
      storeKey,
      job,
      receipt,
      taskRunId: task.taskRunId,
      interrupted,
      nowMs,
    });
  }
  finishReceipt(
    restored && finalized
      ? resolveCronRunReceiptTerminalStatus(finalized.entry.status, finalized.triggerEval?.fired)
      : "interrupted",
    restored && finalized ? finalized.entry.ts : nowMs,
    restored && finalized ? finalized.entry.error : STARTUP_INTERRUPTED_ERROR,
  );
  if (restored?.shouldDelete) {
    deleteCronJobRowInDatabase(database.db, storeKey, job.id);
    return { removed: true, skipStartupCatchup: true };
  }
  updateCronRuntimeRow(database.db, storeKey, job, previousEnabled);
  return {
    ...(interrupted ? { interrupted } : {}),
    ...(restored?.replacementAtMs === undefined && interrupted?.replacementAtMs === undefined
      ? { skipStartupCatchup: true }
      : {}),
  };
}
