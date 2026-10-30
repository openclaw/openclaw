import type { EngineConnection } from "../../infra/sql-connection.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import {
  applyCronRunHistoryMaintenanceInDatabase,
  planCronRunHistoryMaintenance,
  readCronRunRecordsInDatabase,
} from "./run-history.kernel.js";
import type { CronRunRecord } from "./run-history.types.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

export function maintainCronRunHistoryInWorker(
  database: OpenClawStateDatabase,
  input: { snapshot: CronRuntimeMutationContracts["cron.maintainHistory"]["snapshot"] },
): CronRuntimeWorkerOperations["cron.maintainHistory"]["output"] {
  // Planning facts decide this sweep; retained payloads load below only for runs it reconciles,
  // so a large history is never materialized whole in the heap-limited worker.
  const records = readCronRunRecordsInDatabase(database.db, undefined, undefined, {
    planningOnly: true,
  });
  const jobIds = [
    ...new Set(
      records.flatMap((row) =>
        (row.status === "queued" ||
          row.status === "running" ||
          (row.status === "lost" &&
            row.error?.trim().toLowerCase().includes("backing session missing"))) &&
        row.jobId?.trim()
          ? [row.jobId.trim()]
          : [],
      ),
    ),
  ];
  const receipts =
    jobIds.length > 0 && tableExists(database.db, "cron_run_receipts")
      ? readActiveCronRunReceiptsInDatabase(database.db, undefined, jobIds)
      : [];
  const { nowMs, protectedJobIds } = input.snapshot;
  const protectedJobs = new Set([...protectedJobIds, ...receipts.map((receipt) => receipt.jobId)]);
  const plan = planWithReconciliationPayloads(database.db, records, nowMs, protectedJobs);
  if (plan.reconciliations.length === 0 && plan.pruneIds.length === 0) {
    return { outcome: { reconciled: 0, pruned: 0, nextSweepAtMs: plan.nextSweepAtMs } };
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => ({
      outcome: {
        ...applyCronRunHistoryMaintenanceInDatabase(db, plan, prepareCronRunReceiptWriteSchema(db)),
        nextSweepAtMs: plan.nextSweepAtMs,
      },
    }),
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.history-maintenance" },
  );
}

/**
 * Reconciliation copies the reconciled row's own payload, or that of its recovery candidate, which
 * shares the row's exact job and run identity. Load full payloads for exactly those rows, by task
 * id, and replan on them; every other row keeps its planning projection.
 */
function planWithReconciliationPayloads(
  db: EngineConnection,
  records: readonly CronRunRecord[],
  nowMs: number,
  protectedJobs: ReadonlySet<string>,
) {
  const draft = planCronRunHistoryMaintenance(records, nowMs, protectedJobs);
  if (draft.reconciliations.length === 0) {
    return draft;
  }
  const runKey = (row: CronRunRecord) => JSON.stringify([row.jobId, row.runId]);
  const reconciledRuns = new Set(
    draft.reconciliations.flatMap((row) =>
      row.jobId?.trim() && row.runId?.trim() ? [runKey(row)] : [],
    ),
  );
  const reconciledIds = new Set(draft.reconciliations.map((row) => row.id));
  const taskIds = records.flatMap((row) =>
    reconciledIds.has(row.id) || reconciledRuns.has(runKey(row)) ? [row.id] : [],
  );
  const payloads = new Map<string, CronRunRecord>();
  for (let offset = 0; offset < taskIds.length; offset += 500) {
    for (const row of readCronRunRecordsInDatabase(db, undefined, undefined, {
      taskIds: taskIds.slice(offset, offset + 500),
    })) {
      payloads.set(row.id, row);
    }
  }
  const hydrated = records.map((row) => {
    const full = payloads.get(row.id);
    return full === undefined ? row : { ...row, summary: full.summary, detail: full.detail };
  });
  return planCronRunHistoryMaintenance(hydrated, nowMs, protectedJobs);
}

export function scheduleUnownedCronJobsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.scheduleUnowned"]["input"],
): CronRuntimeWorkerOperations["cron.scheduleUnowned"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, input.storeKey);
      const decoded = loadedCronStoreFromRows(rows).store.jobs;
      const activeJobIds = listActiveCronRunReceiptJobIdsInDatabase(db, input.storeKey);
      const jobsById = new Map(decoded.map((job) => [job.id, job]));
      const policy = input.snapshot;
      const outcome: CronRuntimeMutationContracts["cron.scheduleUnowned"]["outcome"] = {
        changed: false,
        jobs: [],
        notifications: [],
        logs: [],
      };
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => policy.nowMs,
          log: createCronMutationLogger(outcome.logs),
        },
      };
      for (const row of rows) {
        const job = jobsById.get(row.job_id);
        if (
          !job ||
          activeJobIds.has(row.job_id) ||
          (input.options?.preserveExpiredPacedNextRunJobId === row.job_id && !job.enabled)
        ) {
          continue;
        }
        const previousEnabled = job.enabled ?? true;
        if (
          recomputeSingleJobForMaintenance(
            state,
            job,
            {
              ...input.options,
              nowMs: policy.nowMs,
              deferredNotifications: outcome.notifications,
            },
            { reservations: new Map(), isJobActive: () => false },
          )
        ) {
          updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
          outcome.jobs.push(job);
          outcome.changed = true;
        }
      }
      return { outcome };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.schedule-unowned" },
  );
}

export function recordCronFailureAlertOutcomeInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.recordFailureAlertOutcome"]["input"],
): CronRuntimeWorkerOperations["cron.recordFailureAlertOutcome"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = loadCronRows(db, input.storeKey, new Set([input.jobId]))[0];
      const job = row ? loadedCronStoreFromRows([row]).store.jobs[0] : undefined;
      const jobs = job ? [job] : [];
      const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey: input.storeKey, jobs });
      if (repairJobIds.length > 0) {
        repairCronRuntimeAuthorityRows({
          db,
          storeKey: input.storeKey,
          jobs,
          jobIds: repairJobIds,
        });
      }
      const ownsCycle =
        job !== undefined &&
        job.state.lastRunAtMs === input.runAtMs &&
        job.state.lastFailureAlertAtMs === input.alertAtMs &&
        job.state.lastFailureNotificationId === input.notificationId &&
        job.state.lastFailureNotificationDeliveryStatus === "unknown";
      if (job && row && ownsCycle) {
        job.state.lastFailureNotificationDelivered = input.outcome.delivered;
        job.state.lastFailureNotificationDeliveryStatus = input.outcome.status;
        job.state.lastFailureNotificationDeliveryError = input.outcome.error;
        updateCronRuntimeRow(db, input.storeKey, job);
      }
      return { outcome: { job: ownsCycle ? job : undefined } };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.failure-alert-outcome" },
  );
}

export function recordCronFailureRepairSettlementInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.recordFailureRepairSettlement"]["input"],
): CronRuntimeWorkerOperations["cron.recordFailureRepairSettlement"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase<
        CronRuntimeMutationContracts["cron.recordFailureRepairSettlement"]["outcome"]
      >({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set([input.jobId]),
        mutate({ jobs }) {
          const job = jobs.get(input.jobId);
          const repair = job?.state.failureAlertIncident?.repair;
          if (
            !job ||
            !repair ||
            repair.alerted ||
            repair.atMs !== input.repairAtMs ||
            job.state.lastFailureNotificationId !== input.repairId
          ) {
            return { value: {} };
          }
          repair.settledAtMs = input.settledAtMs;
          return { upsertJobIds: [job.id], value: { job } };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.failure-repair-settlement" },
  );
}
