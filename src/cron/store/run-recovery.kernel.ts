import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { recomputeJobNextRunAtMs } from "../service/jobs-scheduling.js";
import { findCronRunRecoveryInDatabase } from "../service/run-history-recovery.js";
import { resolveCronRunReceiptTerminalStatus } from "../service/run-receipts.js";
import {
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
} from "../service/startup-run-repair.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "../service/state.js";
import type { CronJob } from "../types.js";
import { deleteCronJobRowInDatabase, upsertCronJobRow } from "./row-codec.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
  exactCronRunReceiptMatches,
} from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRunRecoveryProposal } from "./run-recovery-read.types.js";
import type { CronRunRecoveryResult, InterruptedStartupRun } from "./run-recovery.types.js";
import type { CronJobReadRow } from "./schema.js";

export function repairCronRunInDatabase(params: {
  state: CronJobPolicyContext;
  storeKey: string;
  database: OpenClawStateDatabase;
  receiptSchema: CronRunReceiptWriteSchema;
  row: CronJobReadRow | undefined;
  job: CronJob | undefined;
  proposal: CronRunRecoveryProposal;
  proposedReceiptIsStale: boolean;
  mode: "startup" | "reclaim";
}): CronRunRecoveryResult {
  const { state, database, proposal } = params;
  const { storeKey } = params;
  const currentReceipt = findActiveCronRunReceiptInDatabase({
    database: database.db,
    storePath: storeKey,
    jobId: proposal.jobId,
  });
  if (proposal.receipt) {
    // Receipt identity is the recovery CAS. The millisecond marker is checked
    // only after this succeeds because successive runs may share a timestamp.
    if (!exactCronRunReceiptMatches(currentReceipt, proposal.receipt) && currentReceipt) {
      return { kind: "superseded", receipt: currentReceipt };
    }
    if (currentReceipt && !params.proposedReceiptIsStale) {
      return { kind: "live", receipt: currentReceipt };
    }
  } else if (currentReceipt) {
    return { kind: "superseded", receipt: currentReceipt };
  }

  const { row, job } = params;
  if (!row || !job) {
    if (proposal.receipt && currentReceipt) {
      finishCronRunReceiptInDatabase({
        receiptSchema: params.receiptSchema,
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after the job row was finalized",
      });
      return { kind: "repaired", notifications: [] };
    }
    return { kind: "superseded" };
  }
  if (
    proposal.runningAtMs !== undefined &&
    job.state.runningAtMs === proposal.runningAtMs &&
    job.state.runningReceiptId !== proposal.runningReceiptId
  ) {
    return { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) };
  }
  let changed = false;
  if (proposal.queuedAtMs !== undefined && job.state.queuedAtMs === proposal.queuedAtMs) {
    delete job.state.queuedAtMs;
    if (proposal.receipt && currentReceipt) {
      finishCronRunReceiptInDatabase({
        receiptSchema: params.receiptSchema,
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: queued run interrupted because owner is unavailable",
      });
    }
    changed = true;
  }
  let interrupted: InterruptedStartupRun | undefined;
  let replacementAtMs: number | undefined;
  const notifications: DeferredCronNotifications = [];
  if (proposal.runningAtMs !== undefined) {
    if (job.state.runningAtMs !== proposal.runningAtMs) {
      if (proposal.receipt && currentReceipt) {
        finishCronRunReceiptInDatabase({
          receiptSchema: params.receiptSchema,
          database: database.db,
          handle: proposal.receipt,
          status: "interrupted",
          finishedAtMs: state.deps.nowMs(),
          error: "cron: owner unavailable after run state was already finalized",
        });
        return { kind: "repaired", notifications: [] };
      }
      return { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) };
    }
    const task = findCronRunRecoveryInDatabase({
      database: database.db,
      jobId: proposal.jobId,
      startedAt: proposal.runningAtMs,
      storeKey,
      receiptId: proposal.runningReceiptId ?? proposal.receipt?.receiptId,
    });
    const finalized = task.finalized;
    const receiptId = proposal.runningReceiptId ?? currentReceipt?.receiptId ?? task.receiptId;
    const triggerStateRetired = receiptId
      ? isCronRunTriggerStateRetiredInDatabase({
          database: database.db,
          handle: {
            receiptId,
            storeKey,
            jobId: proposal.jobId,
            startedAtMs: proposal.runningAtMs,
          },
        })
      : false;
    const restored = finalized
      ? restoreFinalizedStartupRun({
          state,
          job,
          runningAtMs: proposal.runningAtMs,
          entry: finalized.entry,
          triggerStateRetired,
          ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
          ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
          deferredNotifications: notifications,
        })
      : undefined;
    replacementAtMs = restored?.replacementAtMs;
    if (!restored) {
      const nowMs = state.deps.nowMs();
      interrupted = markInterruptedStartupRun({
        state,
        job,
        taskRunId: task.taskRunId,
        runningAtMs: proposal.runningAtMs,
        nowMs,
        recoverInterruptedOneShot: params.mode === "startup",
        deferredNotifications: notifications,
      });
      replacementAtMs = interrupted.replacementAtMs;
      if (job.enabled && job.state.nextRunAtMs === undefined) {
        recomputeJobNextRunAtMs({
          state,
          job,
          nowMs,
          deferredNotifications: notifications,
        });
      }
      if (params.mode === "startup" && job.schedule.kind === "at") {
        // Commit the pending occurrence with receipt retirement, so another
        // restart before admission cannot consume it as terminal run history.
        job.state.startupCatchupAtMs = job.state.nextRunAtMs;
      }
    }
    if (proposal.receipt) {
      finishCronRunReceiptInDatabase({
        receiptSchema: params.receiptSchema,
        database: database.db,
        handle: proposal.receipt,
        status:
          restored && finalized
            ? resolveCronRunReceiptTerminalStatus(
                finalized.entry.status,
                finalized.triggerEval?.fired,
              )
            : "interrupted",
        finishedAtMs: restored && finalized ? finalized.entry.ts : state.deps.nowMs(),
        error:
          restored && finalized
            ? finalized.entry.error
            : "cron: job interrupted because owner is unavailable",
      });
    }
    if (restored?.shouldDelete) {
      deleteCronJobRowInDatabase(database.db, storeKey, proposal.jobId);
      return {
        kind: "repaired",
        notifications,
        ...(restored.replacementAtMs === undefined ? { skipStartupCatchup: true } : {}),
      };
    }
    changed = true;
  }
  if (!changed) {
    if (proposal.receipt && currentReceipt && params.proposedReceiptIsStale) {
      finishCronRunReceiptInDatabase({
        receiptSchema: params.receiptSchema,
        database: database.db,
        handle: proposal.receipt,
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after run marker retirement",
      });
      return { kind: "repaired", notifications };
    }
    return { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) };
  }
  upsertCronJobRow(database.db, storeKey, job, row.sort_order);
  return {
    kind: "repaired",
    ...(interrupted ? { interrupted } : {}),
    notifications,
    ...(replacementAtMs === undefined &&
    proposal.runningAtMs !== undefined &&
    !(params.mode === "startup" && interrupted && job.schedule.kind === "at")
      ? { skipStartupCatchup: true }
      : {}),
  };
}
