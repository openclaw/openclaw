import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import {
  applyCronRunHistoryMaintenanceInDatabase,
  CRON_RUN_MAINTENANCE_DETAIL_KEYS,
  planCronRunHistoryMaintenance,
  readCronRunRecordsInDatabase,
} from "./run-history.kernel.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "./run-receipt-store.js";
import type { CronRunRecord } from "./run-history.types.js";
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
  // Identities and lifecycle facts decide this sweep. The retained payloads are loaded below for
  // the runs it will reconcile, so a large history is never materialized whole.
  const records = readCronRunRecordsInDatabase(database.db, undefined, undefined, {
    detailKeys: CRON_RUN_MAINTENANCE_DETAIL_KEYS,
    terminalSummary: false,
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
  const plan = planCronRunHistoryMaintenance(
    withReconciliationPayloads(database.db, records, nowMs, protectedJobs),
    nowMs,
    protectedJobs,
  );
  if (plan.reconciliations.length === 0 && !plan.prune) {
    return { outcome: { reconciled: 0, pruned: 0, nextSweepAtMs: plan.nextSweepAtMs } };
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => ({
      outcome: {
        ...applyCronRunHistoryMaintenanceInDatabase(
          db,
          plan,
          nowMs,
          prepareCronRunReceiptWriteSchema(db),
        ),
        nextSweepAtMs: plan.nextSweepAtMs,
      },
    }),
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.history-maintenance" },
  );
}

/**
 * Plans the sweep once from identities, then loads the retained payloads only for the runs it will
 * reconcile. The planner reads a reconciled row's `summary`/`detail` and those of its recovery
 * candidate, so rows sharing a job and run load together; an active row without a run identity is
 * loaded by task id, which is also the only payload the planner can read for it.
 */
function withReconciliationPayloads(
  db: EngineConnection,
  records: readonly CronRunRecord[],
  nowMs: number,
  protectedJobs: ReadonlySet<string>,
): CronRunRecord[] {
  const draft = planCronRunHistoryMaintenance(records, nowMs, protectedJobs);
  if (draft.reconciliations.length === 0) {
    return [...records];
  }
  const runs = new Map<string, { jobId: string; runId: string }>();
  const unkeyedTaskIds: string[] = [];
  for (const row of draft.reconciliations) {
    const jobId = row.jobId?.trim();
    const runId = row.runId?.trim();
    if (jobId && runId) {
      runs.set(`${jobId}\u0000${runId}`, { jobId, runId });
    } else {
      unkeyedTaskIds.push(row.id);
    }
  }
  const payloads = new Map<string, CronRunRecord>();
  for (const { jobId, runId } of runs.values()) {
    for (const row of readCronRunRecordsInDatabase(db, jobId, runId)) {
      payloads.set(row.id, row);
    }
  }
  if (unkeyedTaskIds.length > 0) {
    for (const row of readCronRunRecordsInDatabase(db, undefined, undefined, {
      taskIds: unkeyedTaskIds,
    })) {
      payloads.set(row.id, row);
    }
  }
  return records.map((row) => {
    const filled = payloads.get(row.id);
    return filled === undefined ? row : { ...row, summary: filled.summary, detail: filled.detail };
  });
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
