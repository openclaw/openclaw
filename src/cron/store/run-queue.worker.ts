import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId, tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { CRON_ADMISSION_DEFERRED_RECEIPT_ERROR } from "../service/admission-deferred.js";
import { isJobEnabled } from "../service/jobs-scheduling.js";
import { retainManualOneShotOccurrence } from "../service/one-shot-schedule.js";
import type { CronJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import { recordSkippedCronRequestInDatabase } from "./run-history.kernel.js";
import type {
  CronRunQueueOperations,
  CronRunRequestContext,
  CronSkippedRequest,
} from "./run-queue.types.js";
import { receiptFromRow, receiptHandle, type CronRunReceiptDatabase } from "./run-receipt-read.js";
import {
  activateCronRunReceiptInDatabase,
  claimCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import { createCronScheduledRunId, parseCronScheduledRunId } from "./run-request-id.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";

const ownerStartTime = getFileLockProcessStartTime(process.pid);

function query(db: DatabaseSync) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(db);
}

function loadJobs(db: DatabaseSync, storeKey: string) {
  const jobs = loadedCronStoreFromRows(
    loadCronRows(db, storeKey, undefined, { includeGrantDefinitionProjection: true }),
  ).store.jobs;
  const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey, jobs });
  if (repairJobIds.length > 0) {
    repairCronRuntimeAuthorityRows({ db, storeKey, jobs, jobIds: repairJobIds });
  }
  return new Map(jobs.map((job) => [job.id, job]));
}

function matchingExit(job: CronJob, context: CronRunRequestContext): boolean {
  return (
    job.schedule.kind === "on-exit" &&
    context.onExitSchedule?.command === job.schedule.command &&
    context.onExitSchedule.cwd === job.schedule.cwd
  );
}

function skipRequest(
  db: DatabaseSync,
  receiptSchema: CronRunReceiptWriteSchema,
  handle: CronRunReceiptHandle,
  job: CronJob | undefined,
  nowMs: number,
  error: string,
  status: "skipped" | "superseded" = "skipped",
): CronSkippedRequest {
  finishCronRunReceiptInDatabase({
    database: db,
    receiptSchema,
    handle,
    status,
    finishedAtMs: nowMs,
    error,
  });
  if (job) {
    if (job.state.queuedAtMs === handle.startedAtMs) {
      delete job.state.queuedAtMs;
    }
    if (job.state.runningReceiptId === handle.receiptId) {
      delete job.state.runningAtMs;
      delete job.state.runningReceiptId;
      delete job.state.runningScheduleChangeId;
    }
    updateCronRuntimeRow(db, handle.storeKey, job);
  }
  if (status === "skipped") {
    recordSkippedCronRequestInDatabase(db, {
      storeKey: handle.storeKey,
      jobId: handle.jobId,
      receiptId: handle.receiptId,
      agentId: handle.agentId,
      startedAt: handle.startedAtMs,
      endedAt: nowMs,
      error,
      nextRunAtMs: job?.state.nextRunAtMs,
    });
  }
  return { job, runReceipt: handle, error };
}

export function requestCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.requestRuns"]["input"],
): CronRunQueueOperations["cron.requestRuns"]["output"] {
  if (ownerStartTime === null) {
    throw new Error("cron request cannot identify its Gateway process");
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const jobs = loadJobs(db, input.storeKey);
      const result: CronRunQueueOperations["cron.requestRuns"]["output"] = {
        accepted: [],
        rejected: [],
      };
      for (const request of input.requests) {
        const job = jobs.get(request.jobId);
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom("cron_run_receipts")
            .selectAll()
            .where("receipt_id", "=", request.receiptId),
        );
        const active = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom("cron_run_receipts")
            .select("receipt_id")
            .where("store_key", "=", input.storeKey)
            .where("job_id", "=", request.jobId)
            .where("status", "=", "running"),
        );
        const timed = parseCronScheduledRunId(request.receiptId);
        const deferred =
          request.mode === "scheduled" &&
          existing?.status === "skipped" &&
          existing.error_text === CRON_ADMISSION_DEFERRED_RECEIPT_ERROR;
        let reason: string | undefined;
        if (existing && !deferred) {
          reason = "already-requested";
        } else if (
          !job ||
          active ||
          job.state.queuedAtMs !== undefined ||
          job.state.runningAtMs !== undefined
        ) {
          reason = job ? "already-running" : "job-removed";
        } else if (
          resolveCronJobConfigRevision(job) !== request.configRevision ||
          (!isJobEnabled(job) && request.mode !== "force") ||
          (request.mode === "on-exit" && !matchingExit(job, request)) ||
          (request.mode === "scheduled" &&
            (!timed ||
              timed.storeKey !== input.storeKey ||
              timed.jobId !== job.id ||
              timed.scheduledSlotMs !== job.state.nextRunAtMs ||
              timed.scheduledSlotMs !== request.scheduledSlotMs))
        ) {
          reason = "job-ineligible";
        }
        if (reason || !job) {
          result.rejected.push({
            jobId: request.jobId,
            receiptId: request.receiptId,
            reason: reason ?? "job-removed",
          });
          continue;
        }
        const agentId = tryResolveCronJobEffectiveAgentId(job, input.defaultAgentId);
        if (
          !agentId ||
          !hasCanonicalCronDeliveryMode(job.delivery) ||
          isAgentDeletionBlocked(agentId, {}, db)
        ) {
          result.rejected.push({
            jobId: job.id,
            receiptId: request.receiptId,
            reason: "owner-unavailable",
          });
          continue;
        }
        const handle: CronRunReceiptHandle = {
          // An unstarted attempt did not consume its slot. Give the next
          // attempt its own fence while preserving that slot's identity.
          receiptId:
            deferred && timed
              ? createCronScheduledRunId(
                  input.storeKey,
                  job.id,
                  timed.scheduledSlotMs,
                  randomUUID(),
                )
              : request.receiptId,
          storeKey: input.storeKey,
          jobId: job.id,
          configRevision: request.configRevision,
          agentId,
          ownerPid: process.pid,
          ownerStartTime,
          startedAtMs: input.nowMs,
        };
        const runReceipt = claimCronRunReceiptInDatabase({
          database: db,
          receiptSchema,
          prepared: {
            handle,
            storeKey: input.storeKey,
            observedStale: false,
            requestRunId: request.requestRunId,
          },
          resolveAgentId: (current) =>
            resolveCronJobEffectiveAgentId(current, input.defaultAgentId),
        });
        const previousEnabled = job.enabled ?? true;
        if (request.mode === "on-exit") {
          job.enabled = false;
          job.updatedAtMs = input.nowMs;
          job.state.scheduleActivatedAtMs = input.nowMs;
          delete job.state.nextRunAtMs;
          delete job.state.startupCatchupAtMs;
          delete job.state.pacedNextRunAtMs;
          delete job.state.forcePreservedNextRunAtMs;
        } else if (request.preserveSchedule) {
          retainManualOneShotOccurrence(job, request.scheduleOwnershipAtMs ?? input.nowMs);
        }
        job.state.queuedAtMs = input.nowMs;
        updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
        result.accepted.push({ job, runReceipt });
      }
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.request-runs" },
  );
}

export function drainCronQueueInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.drainQueue"]["input"],
): CronRunQueueOperations["cron.drainQueue"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const jobs = loadJobs(db, input.storeKey);
      const contexts = new Map(input.requests.map((request) => [request.receiptId, request]));
      const locallyOwned = new Set(input.locallyOwnedReceiptIds);
      const jobOrder = new Map([...jobs.keys()].map((jobId, index) => [jobId, index]));
      const cancelled =
        input.requests.length === 0
          ? []
          : executeSqliteQuerySync(
              db,
              query(db)
                .selectFrom("cron_run_receipts")
                .selectAll()
                .where("store_key", "=", input.storeKey)
                .where("status", "=", "skipped")
                .where("receipt_id", "in", [...contexts.keys()]),
            ).rows.map((row) => ({
              job: jobs.get(row.job_id),
              runReceipt: receiptHandle(receiptFromRow(row)),
              error: row.error_text ?? "cron: queued request was cancelled",
            }));
      const receipts = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("cron_run_receipts")
          .selectAll()
          .where("store_key", "=", input.storeKey)
          .where("status", "=", "running")
          .orderBy("started_at_ms")
          .orderBy("job_id"),
      ).rows.map(receiptFromRow);
      let activeCount = receipts.filter((receipt) => {
        const state = jobs.get(receipt.jobId)?.state;
        return state?.runningReceiptId === receipt.receiptId && state.runningAtMs !== undefined;
      }).length;
      const queued = receipts
        .filter((receipt) => jobs.get(receipt.jobId)?.state.queuedAtMs === receipt.startedAtMs)
        .toSorted((left, right) => {
          const leftSlot =
            parseCronScheduledRunId(left.receiptId)?.scheduledSlotMs ?? left.startedAtMs;
          const rightSlot =
            parseCronScheduledRunId(right.receiptId)?.scheduledSlotMs ?? right.startedAtMs;
          return leftSlot - rightSlot || jobOrder.get(left.jobId)! - jobOrder.get(right.jobId)!;
        });
      const result: CronRunQueueOperations["cron.drainQueue"]["output"] = {
        launches: [],
        skipped: cancelled,
      };
      for (const receipt of queued) {
        if (!contexts.has(receipt.receiptId) && locallyOwned.has(receipt.receiptId)) {
          // Another service in this Gateway owns the transient launch context.
          continue;
        }
        const handle = receiptHandle(receipt);
        const job = jobs.get(receipt.jobId)!;
        const timed = parseCronScheduledRunId(receipt.receiptId);
        const context =
          contexts.get(receipt.receiptId) ??
          (timed?.storeKey === input.storeKey && timed.jobId === job.id
            ? { receiptId: receipt.receiptId, mode: "scheduled" as const }
            : undefined);
        const agentId = tryResolveCronJobEffectiveAgentId(job, input.defaultAgentId);
        const error = !context
          ? "cron: queued request lost its launch context"
          : (!isJobEnabled(job) && context.mode !== "force" && context.mode !== "on-exit") ||
              (context.mode === "on-exit" && !matchingExit(job, context))
            ? "cron: queued job is no longer eligible"
            : !agentId ||
                !hasCanonicalCronDeliveryMode(job.delivery) ||
                isAgentDeletionBlocked(agentId, {}, db)
              ? "cron: queued job owner is unavailable"
              : undefined;
        if (error || !agentId) {
          result.skipped.push(
            skipRequest(
              db,
              receiptSchema,
              handle,
              job,
              input.nowMs,
              error ?? "cron: queued job owner is unavailable",
            ),
          );
          continue;
        }
        if (
          (input.schedulingPaused && context?.mode === "scheduled") ||
          activeCount >= Math.max(1, input.maxConcurrentRuns)
        ) {
          continue;
        }
        if (ownerStartTime === null) {
          throw new Error("cron request cannot identify its Gateway process");
        }
        // Payload edits take effect while queued; active runs keep this committed snapshot.
        const currentHandle = {
          ...handle,
          ownerPid: process.pid,
          ownerStartTime,
          agentId,
          configRevision: resolveCronJobConfigRevision(job),
        };
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("cron_run_receipts")
            .set({
              config_revision: currentHandle.configRevision,
              agent_id: agentId,
              owner_pid: currentHandle.ownerPid,
              owner_start_time: currentHandle.ownerStartTime,
            })
            .where("receipt_id", "=", handle.receiptId)
            .where("status", "=", "running"),
        );
        const runReceipt = activateCronRunReceiptInDatabase({
          database: db,
          handle: currentHandle,
          startedAtMs: input.nowMs,
          resolveAgentId: (current) =>
            resolveCronJobEffectiveAgentId(current, input.defaultAgentId),
        });
        delete job.state.queuedAtMs;
        job.state.runningAtMs = input.nowMs;
        job.state.runningReceiptId = runReceipt.receiptId;
        delete job.state.runningScheduleChangeId;
        updateCronRuntimeRow(db, input.storeKey, job);
        result.launches.push({ job, runReceipt });
        activeCount += 1;
      }
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.drain-queue" },
  );
}

export function cancelCronRequestsInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.cancelRequests"]["input"],
): CronRunQueueOperations["cron.cancelRequests"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const jobs = loadJobs(db, input.storeKey);
      const skipped: CronSkippedRequest[] = [];
      if (input.receiptIds.length > 0) {
        const rows = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("cron_run_receipts")
            .selectAll()
            .where("store_key", "=", input.storeKey)
            .where("status", "=", "running")
            .where("receipt_id", "in", input.receiptIds),
        ).rows;
        for (const row of rows) {
          const handle = receiptHandle(receiptFromRow(row));
          skipped.push(
            skipRequest(
              db,
              receiptSchema,
              handle,
              jobs.get(row.job_id),
              input.nowMs,
              input.reason,
              input.status,
            ),
          );
        }
      }
      return { skipped };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.cancel-requests" },
  );
}
