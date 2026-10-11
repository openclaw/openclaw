import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import {
  pruneCronRunHistoryInDatabase,
  readCronRunRecordsInDatabase,
  reconcileCronRunHistoryInDatabase,
} from "./run-history.kernel.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import {
  isCronRunReceiptOwnerStale,
  listActiveCronRunReceiptJobIdsInDatabase,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

export function maintainCronRunHistoryInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.maintainHistory"]["input"],
): CronRuntimeWorkerOperations["cron.maintainHistory"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const schema = prepareCronRunReceiptWriteSchema(db);
      const records = readCronRunRecordsInDatabase(db);
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
      const receipts = schema.cronRunReceipts
        ? readActiveCronRunReceiptsInDatabase(db, undefined, jobIds)
        : [];
      const { nowMs, protectedJobIds, locallyOwnedReceiptIds } = input.snapshot;
      const protectedJobs = new Set([
        ...protectedJobIds,
        ...receipts
          // Host-only liveness is captured before dispatch; new ownership may race this snapshot.
          .filter((receipt) =>
            receipt.ownerPid === process.pid
              ? locallyOwnedReceiptIds.includes(receipt.receiptId)
              : !isCronRunReceiptOwnerStale(receipt, nowMs),
          )
          .map((receipt) => receipt.jobId),
      ]);
      const reconciled = reconcileCronRunHistoryInDatabase(db, records, nowMs, protectedJobs);
      // Newly lost rows retain their first lost observation until the next sweep, as before.
      const pruned = pruneCronRunHistoryInDatabase(
        db,
        nowMs,
        schema,
        records.filter((row) => !reconciled.has(row.id)),
      );
      return { outcome: { reconciled: reconciled.size, pruned } };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.history-maintenance" },
  );
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
      const reservations = new Map(
        policy.ownership.flatMap((owner) =>
          owner.reservation ? [[owner.jobId, owner.reservation] as const] : [],
        ),
      );
      const active = new Set(
        policy.ownership.filter((owner) => owner.active).map((owner) => owner.jobId),
      );
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
        if (!job || activeJobIds.has(row.job_id)) {
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
            { reservations, isJobActive: (jobId) => active.has(jobId) },
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
