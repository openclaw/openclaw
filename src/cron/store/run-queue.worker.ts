import { randomUUID } from "node:crypto";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  getPluginCommandRunBudgetError,
  isPluginCommandCronJob,
  rebindPluginCommandSchedule,
  retirePluginCommandJob,
} from "../plugin-command-schedule.js";
import {
  isProactiveJobMigrationPending,
  readDefaultProactiveJobReceiptInDatabase,
} from "../proactive-job-receipt.kernel.js";
import { CRON_ADMISSION_DEFERRED_RECEIPT_ERROR } from "../service/admission-deferred.js";
import { isJobEnabled, recomputeJobNextRunAtMs } from "../service/jobs-scheduling.js";
import { retainManualOneShotOccurrence } from "../service/one-shot-schedule.js";
import type { CronJob, CronStoredJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import { readCronEventClaimInDatabase, transferCronEventInDatabase } from "./event-ingress.js";
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
import { createCronMutationLogger } from "./runtime-mutation.worker.js";

const ownerStartTime = getFileLockProcessStartTime(process.pid);
const MAX_CONCURRENT_CONDITION_CHECKS = 3;

function query(db: EngineConnection) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(db);
}

/** A condition check is the opening phase of a run; at most three runs are in that phase. */
function isCheckingCondition(job: CronStoredJob): boolean {
  return (
    job.state.runningAtMs !== undefined &&
    job.state.conditionCheckReceiptId === job.state.runningReceiptId
  );
}

/**
 * A timed check holds no run slot: it is short and bounded, and run slots are for payloads.
 * A requested check keeps the slot it was activated with. So does a script payload's check,
 * whose time budget cannot pause while it waits for a slot.
 */
function startsWithoutRunSlot(job: CronStoredJob, receiptId: string): boolean {
  return job.payload.kind !== "script" && parseCronScheduledRunId(receiptId) !== undefined;
}

/** A fired condition waiting for a run slot: it holds neither a check nor a slot. */
function awaitsRunSlot(job: CronStoredJob | undefined, receiptId: string): boolean {
  return (
    job?.state.runningAtMs !== undefined &&
    job.state.runningReceiptId === receiptId &&
    job.state.runSlotWaitReceiptId === receiptId
  );
}

function countRunSlotsInUse(
  receipts: readonly { receiptId: string; jobId: string }[],
  jobs: ReadonlyMap<string, CronStoredJob>,
): number {
  return receipts.filter((receipt) => {
    const job = jobs.get(receipt.jobId);
    return (
      job?.state.runningReceiptId === receipt.receiptId &&
      job.state.runningAtMs !== undefined &&
      !awaitsRunSlot(job, receipt.receiptId) &&
      !(isCheckingCondition(job) && startsWithoutRunSlot(job, receipt.receiptId))
    );
  }).length;
}

function loadJobs(db: EngineConnection, storeKey: string) {
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
  db: EngineConnection,
  receiptSchema: CronRunReceiptWriteSchema,
  handle: CronRunReceiptHandle,
  job: CronJob | undefined,
  nowMs: number,
  error: string,
  status: "skipped" | "superseded" = "skipped",
  previousEnabled?: boolean,
): CronSkippedRequest {
  finishCronRunReceiptInDatabase({
    database: db,
    receiptSchema,
    handle,
    pendingReceiptId:
      job?.state.runningAtMs === undefined ? handle.receiptId : job.state.runningReceiptId,
    status,
    finishedAtMs: nowMs,
    error,
  });
  if (job) {
    delete job.state.admissionDeferred;
    if (job.state.queuedAtMs === handle.startedAtMs) {
      delete job.state.queuedAtMs;
    }
    if (job.state.runningReceiptId === handle.receiptId) {
      delete job.state.runningAtMs;
      delete job.state.runningReceiptId;
      delete job.state.runningScheduleChangeId;
    }
    updateCronRuntimeRow(db, handle.storeKey, job, previousEnabled);
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
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const hasEvents = input.requests.some((request) => request.event !== undefined);
      if (hasEvents) {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      }
      const result = requestCronRunsInDatabase(db, input, loadJobs(db, input.storeKey));
      if (hasEvents) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      }
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.request-runs" },
  );
}

function requestCronRunsInDatabase(
  db: EngineConnection,
  input: CronRunQueueOperations["cron.requestRuns"]["input"],
  jobs: Map<string, CronStoredJob>,
  persistQueuedState = true,
): CronRunQueueOperations["cron.requestRuns"]["output"] {
  const result: CronRunQueueOperations["cron.requestRuns"]["output"] = {
    accepted: [],
    rejected: [],
  };
  for (const request of input.requests) {
    const job = jobs.get(request.jobId);
    const timed = parseCronScheduledRunId(request.receiptId);
    // A retry can outlive its original receipt; the latest retained attempt owns the slot.
    let existing =
      request.mode === "scheduled" && timed
        ? executeSqliteQuerySync(
            db,
            query(db)
              .selectFrom("cron_run_receipts")
              .select(["receipt_id", "status", "error_text"])
              .where("store_key", "=", input.storeKey)
              .where("job_id", "=", request.jobId)
              .orderBy("cursor_id", "desc"),
          ).rows.find((row) => {
            const slot = parseCronScheduledRunId(row.receipt_id);
            return (
              slot?.storeKey === input.storeKey &&
              slot.jobId === request.jobId &&
              slot.scheduledSlotMs === timed.scheduledSlotMs
            );
          })
        : undefined;
    const deferred =
      existing?.status === "skipped" &&
      existing.error_text === CRON_ADMISSION_DEFERRED_RECEIPT_ERROR;
    let reason: string | undefined;
    if (request.event && (!job || !readCronEventClaimInDatabase(db, job, request.event))) {
      reason = "event-invalidated";
    } else if (!job || job.state.queuedAtMs !== undefined || job.state.runningAtMs !== undefined) {
      reason = job ? "already-running" : "job-removed";
    } else if (
      (request.mode === "scheduled" &&
        input.nowMs < (job.state.admissionDeferred?.retryAtMs ?? 0)) ||
      resolveCronJobConfigRevision(job) !== request.configRevision ||
      // Disabling a command schedule withdraws its unattended authority, including force runs.
      (!isJobEnabled(job) && (request.mode !== "force" || isPluginCommandCronJob(job))) ||
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
    if (existing && !deferred && reason !== "event-invalidated") {
      reason = "already-requested";
    }
    let runReceipt: CronRunReceiptHandle | undefined;
    if (!reason && job) {
      const agentId = tryResolveCronJobEffectiveAgentId(job, input.defaultAgentId);
      if (
        !agentId ||
        !hasCanonicalCronDeliveryMode(job.delivery) ||
        isAgentDeletionBlocked(agentId, {}, db)
      ) {
        reason = "owner-unavailable";
      } else {
        runReceipt = claimCronRunReceiptInDatabase({
          database: db,
          handle: {
            // An unstarted attempt retains its slot, but the retry needs its own fence.
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
          },
          requestRunId: request.requestRunId,
          replaceDeferred:
            deferred && existing
              ? {
                  receiptId: existing.receipt_id,
                  receiptSchema: prepareCronRunReceiptWriteSchema(db),
                }
              : undefined,
        });
      }
    }
    if (!runReceipt || !job) {
      // Other requests need receipt inspection only after the claim rejects.
      existing ??= executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom("cron_run_receipts")
          .select(["receipt_id", "status", "error_text"])
          .where("receipt_id", "=", request.receiptId),
      );
      // An existing receipt must not mask a retired or consumed event claim.
      if (existing && reason !== "event-invalidated") {
        if (
          !deferred &&
          existing.status !== "running" &&
          job &&
          timed &&
          request.mode === "scheduled" &&
          timed.scheduledSlotMs === job.state.nextRunAtMs
        ) {
          recomputeJobNextRunAtMs({
            state: { deps: { nowMs: () => input.nowMs, log: createCronMutationLogger([]) } },
            job,
            nowMs: input.nowMs,
            deferredNotifications: [],
            skipScheduleErrorHandling: true,
          });
          updateCronRuntimeRow(db, input.storeKey, job);
        }
        reason = "already-requested";
      }
      result.rejected.push({
        jobId: request.jobId,
        receiptId: request.receiptId,
        reason: reason ?? "already-running",
      });
      continue;
    }
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
    } else {
      delete job.state.forcePreservedNextRunAtMs;
    }
    job.state.queuedAtMs = input.nowMs;
    if (persistQueuedState) {
      updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
    }
    result.accepted.push({ job, runReceipt });
  }
  return result;
}

export function drainCronQueueInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.drainQueue"]["input"],
): CronRunQueueOperations["cron.drainQueue"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const hasEvents = input.requests.some((request) => request.event !== undefined);
      if (hasEvents) {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      }
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const result = drainCronQueueInDatabase(
        db,
        input,
        loadJobs(db, input.storeKey),
        receiptSchema,
      );
      if (hasEvents) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      }
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.drain-queue" },
  );
}

function drainCronQueueInDatabase(
  db: EngineConnection,
  input: CronRunQueueOperations["cron.drainQueue"]["input"],
  jobs: Map<string, CronStoredJob>,
  receiptSchema: CronRunReceiptWriteSchema,
  freshReceipts?: Set<string>,
): CronRunQueueOperations["cron.drainQueue"]["output"] {
  const contexts = new Map(input.requests.map((request) => [request.receiptId, request]));
  const jobOrder = new Map([...jobs.keys()].map((jobId, index) => [jobId, index]));
  const rows = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("store_key", "=", input.storeKey)
      .where((eb) =>
        contexts.size === 0
          ? eb("status", "=", "running")
          : eb.or([
              eb("status", "=", "running"),
              eb.and([eb("status", "=", "skipped"), eb("receipt_id", "in", [...contexts.keys()])]),
            ]),
      )
      .orderBy("started_at_ms")
      .orderBy("job_id"),
  ).rows;
  const cancelled = rows
    .filter((row) => row.status === "skipped")
    .map((row) => ({
      job: jobs.get(row.job_id),
      runReceipt: receiptHandle(receiptFromRow(row)),
      error: row.error_text ?? "cron: queued request was cancelled",
    }));
  const receipts = rows.filter((row) => row.status === "running").map(receiptFromRow);
  let activeCount = countRunSlotsInUse(receipts, jobs);
  // Fired conditions waiting for a run slot take their turn among queued runs by due time.
  const queued = receipts
    .filter(
      (receipt) =>
        jobs.get(receipt.jobId)?.state.queuedAtMs === receipt.startedAtMs ||
        awaitsRunSlot(jobs.get(receipt.jobId), receipt.receiptId),
    )
    .toSorted((left, right) => {
      const leftSlot = parseCronScheduledRunId(left.receiptId)?.scheduledSlotMs ?? left.startedAtMs;
      const rightSlot =
        parseCronScheduledRunId(right.receiptId)?.scheduledSlotMs ?? right.startedAtMs;
      return leftSlot - rightSlot || jobOrder.get(left.jobId)! - jobOrder.get(right.jobId)!;
    });
  const result: CronRunQueueOperations["cron.drainQueue"]["output"] = {
    launches: [],
    preparing: [],
    skipped: cancelled,
  };
  // At most three runs check a condition at once; the rest stay queued in due order with no
  // running marker, so they spend no run budget and keep their occurrence across a restart.
  let checkingCount = [...jobs.values()].filter(isCheckingCondition).length;
  for (const receipt of queued) {
    const handle = receiptHandle(receipt);
    const job = jobs.get(receipt.jobId)!;
    if (awaitsRunSlot(job, receipt.receiptId)) {
      // Its check already ran; the host waiting on it starts the payload once the mark is gone.
      if (!input.schedulingPaused && activeCount < Math.max(1, input.maxConcurrentRuns)) {
        delete job.state.runSlotWaitReceiptId;
        updateCronRuntimeRow(db, input.storeKey, job);
        activeCount += 1;
      }
      continue;
    }
    const timed = parseCronScheduledRunId(receipt.receiptId);
    const context =
      contexts.get(receipt.receiptId) ??
      (timed?.storeKey === input.storeKey && timed.jobId === job.id
        ? { receiptId: receipt.receiptId, mode: "scheduled" as const }
        : undefined);
    if (!context) {
      // A sibling facade may hold this transient payload; startup owns lost-context recovery.
      continue;
    }
    if (context.event && !readCronEventClaimInDatabase(db, job, context.event)) {
      result.skipped.push({
        ...skipRequest(db, receiptSchema, handle, job, input.nowMs, "cron event claim invalidated"),
        eventInvalidated: true,
      });
      continue;
    }
    const fresh = freshReceipts?.has(receipt.receiptId) === true;
    // A newly claimed request still has the eligibility and owner admitted above.
    const agentId = fresh
      ? receipt.agentId
      : tryResolveCronJobEffectiveAgentId(job, input.defaultAgentId);
    const error = fresh
      ? undefined
      : (!isJobEnabled(job) &&
            ((context.mode !== "force" && context.mode !== "on-exit") ||
              isPluginCommandCronJob(job))) ||
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
    const checksCondition =
      job.trigger !== undefined &&
      (context.mode === "scheduled" || context.evaluateTrigger === true);
    if (
      input.preparingAgentIds?.includes(agentId) ||
      (timed && input.busyConversationJobIds?.includes(job.id))
    ) {
      // Keep durable custody without spending capacity while the host awaits admission or an idle
      // conversation. Only timed occurrences wait here for their conversation: startup recovers
      // them from the queue, and an event's source needs its transfer acknowledged at once.
      result.preparing.push({ job, runReceipt: { ...handle, agentId } });
      continue;
    }
    const withoutRunSlot = checksCondition && startsWithoutRunSlot(job, receipt.receiptId);
    if (
      (input.schedulingPaused && context.mode === "scheduled") ||
      (checksCondition && checkingCount >= MAX_CONCURRENT_CONDITION_CHECKS) ||
      (!withoutRunSlot && activeCount >= Math.max(1, input.maxConcurrentRuns))
    ) {
      continue;
    }
    // Restart continuity shares the claim transaction with the budget check and the charge.
    rebindPluginCommandSchedule(job, input.nowMs, input.hostProcessId, input.pluginCommandHosts);
    const budgetError = getPluginCommandRunBudgetError(job, input.nowMs, input.hostProcessId);
    if (budgetError) {
      // Retire with the terminal receipt, before any attempt is spent, so it never wakes again.
      const previousEnabled = job.enabled ?? true;
      retirePluginCommandJob(job, input.nowMs);
      result.skipped.push(
        skipRequest(
          db,
          receiptSchema,
          handle,
          job,
          input.nowMs,
          budgetError,
          "skipped",
          previousEnabled,
        ),
      );
      continue;
    }
    const previousEnabled = job.enabled ?? true;
    if (job.pluginCommand) {
      // The guard, receipt activation, and monotonic charge share this transaction.
      // Recovery never refunds a launch whose execution outcome may be unknown.
      job.state.pluginCommandRuns = (job.state.pluginCommandRuns ?? 0) + 1;
      if (job.state.pluginCommandRuns >= job.pluginCommand.maxRuns) {
        // The final attempt still runs under the retired definition its receipt records;
        // the job cannot be scheduled or forced again.
        retirePluginCommandJob(job, input.nowMs);
      }
    }
    // Payload edits take effect while queued; active runs keep this committed snapshot.
    const migrationPending = isProactiveJobMigrationPending(
      readDefaultProactiveJobReceiptInDatabase(db, input.storeKey, agentId),
      job.id,
    );
    const currentHandle = {
      ...handle,
      ownerPid: process.pid,
      ownerStartTime,
      agentId,
      configRevision: resolveCronJobConfigRevision(job),
    };
    const runReceipt = fresh
      ? currentHandle
      : activateCronRunReceiptInDatabase({
          database: db,
          handle: currentHandle,
          startedAtMs: input.nowMs,
        });
    if (context.event) {
      transferCronEventInDatabase(db, job, context.event, runReceipt, input.nowMs);
    }
    delete job.state.queuedAtMs;
    job.state.runningAtMs = input.nowMs;
    job.state.runningReceiptId = runReceipt.receiptId;
    // Both marks are bound to a receipt, so they lapse with the run and need no other cleanup.
    delete job.state.runSlotWaitReceiptId;
    if (checksCondition) {
      job.state.conditionCheckReceiptId = runReceipt.receiptId;
      checkingCount += 1;
    } else {
      delete job.state.conditionCheckReceiptId;
    }
    delete job.state.runningScheduleChangeId;
    updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
    result.launches.push({ job, runReceipt, migrationPending });
    activeCount += withoutRunSlot ? 0 : 1;
  }
  return result;
}

/** The scheduler owns these postimages until its synchronous command returns. */
export function requestAndDrainCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.requestRuns"]["input"],
  queue: Pick<
    CronRunQueueOperations["cron.drainQueue"]["input"],
    | "requests"
    | "maxConcurrentRuns"
    | "schedulingPaused"
    | "preparingAgentIds"
    | "busyConversationJobIds"
    | "hostProcessId"
    | "pluginCommandHosts"
  >,
  jobs: Map<string, CronStoredJob>,
): CronRunQueueOperations["cron.requestRuns"]["output"] &
  CronRunQueueOperations["cron.drainQueue"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const currentJobs = [...jobs.values()];
      const { repairJobIds } = loadCronRuntimeAuthorities({
        db,
        storeKey: input.storeKey,
        jobs: currentJobs,
      });
      if (repairJobIds.length > 0) {
        repairCronRuntimeAuthorityRows({
          db,
          storeKey: input.storeKey,
          jobs: currentJobs,
          jobIds: repairJobIds,
        });
      }
      const requested = requestCronRunsInDatabase(db, input, jobs, false);
      const drained = drainCronQueueInDatabase(
        db,
        { ...input, ...queue },
        jobs,
        receiptSchema,
        new Set(requested.accepted.map(({ runReceipt }) => runReceipt.receiptId)),
      );
      for (const { job } of requested.accepted) {
        if (job.state.queuedAtMs !== undefined) {
          updateCronRuntimeRow(db, input.storeKey, job);
        }
      }
      return { ...requested, ...drained };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.request-and-drain-runs" },
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

export function settleCronConditionCheckInWorker(
  database: OpenClawStateDatabase,
  input: CronRunQueueOperations["cron.settleConditionCheck"]["input"],
): CronRunQueueOperations["cron.settleConditionCheck"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const job = loadJobs(db, input.storeKey).get(input.jobId);
      if (!job || job.state.runningReceiptId !== input.receiptId) {
        return { runSlot: false, stale: true };
      }
      if (awaitsRunSlot(job, input.receiptId)) {
        return { runSlot: false };
      }
      if (!isCheckingCondition(job)) {
        // The queue handed it a run slot.
        return { job, runSlot: true };
      }
      delete job.state.conditionCheckReceiptId;
      // A timed check holds no run slot, so its payload waits for the queue to hand it one.
      const waits = startsWithoutRunSlot(job, input.receiptId);
      if (waits) {
        job.state.runSlotWaitReceiptId = input.receiptId;
      }
      updateCronRuntimeRow(db, input.storeKey, job);
      return { job, runSlot: !waits };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.settle-condition-check" },
  );
}
