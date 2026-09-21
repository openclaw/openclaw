import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext, Logger } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows, upsertCronJobRow } from "./row-codec.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "./run-receipt-store.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function scheduleUnownedCronJobsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.scheduleUnowned"]["input"],
): { nonce: string } {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, input.storeKey);
      const decoded = loadedCronStoreFromRows(rows).store.jobs;
      const activeJobIds = listActiveCronRunReceiptJobIdsInDatabase(db, input.storeKey);
      const jobsById = new Map(decoded.map((job) => [job.id, job]));
      const preparation = prepareCronRuntimeMutation("cron.scheduleUnowned", input.nonce, {
        jobIds: decoded.map((job) => job.id),
      });
      const reservations = new Map(
        preparation.ownership.flatMap((owner) =>
          owner.reservation ? [[owner.jobId, owner.reservation] as const] : [],
        ),
      );
      const active = new Set(
        preparation.ownership.filter((owner) => owner.active).map((owner) => owner.jobId),
      );
      const outcome: CronRuntimeMutationContracts["cron.scheduleUnowned"]["outcome"] = {
        changed: false,
        jobs: [],
        notifications: [],
        logs: [],
      };
      const record = (level: keyof Logger) => (fields: unknown, message?: string) => {
        outcome.logs.push({ level, fields, message });
      };
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => preparation.nowMs,
          log: {
            debug: record("debug"),
            info: record("info"),
            warn: record("warn"),
            error: record("error"),
          },
        },
      };
      for (const row of rows) {
        const job = jobsById.get(row.job_id);
        if (!job || activeJobIds.has(row.job_id)) {
          continue;
        }
        if (
          recomputeSingleJobForMaintenance(
            state,
            job,
            {
              ...input.options,
              nowMs: preparation.nowMs,
              deferredNotifications: outcome.notifications,
            },
            { reservations, isJobActive: (jobId) => active.has(jobId) },
          )
        ) {
          upsertCronJobRow(db, input.storeKey, job, row.sort_order);
          outcome.jobs.push(job);
          outcome.changed = true;
        }
      }
      return retainCronRuntimeMutationOutcome("cron.scheduleUnowned", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.schedule-unowned" },
  );
}

export function recordCronFailureAlertOutcomeInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.recordFailureAlertOutcome"]["input"],
): { nonce: string } {
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
      prepareCronRuntimeMutation("cron.recordFailureAlertOutcome", input.nonce, { ownsCycle });
      if (job && row && ownsCycle) {
        job.state.lastFailureNotificationDelivered = input.outcome.delivered;
        job.state.lastFailureNotificationDeliveryStatus = input.outcome.status;
        job.state.lastFailureNotificationDeliveryError = input.outcome.error;
        upsertCronJobRow(db, input.storeKey, job, row.sort_order);
      }
      return retainCronRuntimeMutationOutcome("cron.recordFailureAlertOutcome", db, input.nonce, {
        job: ownsCycle ? job : undefined,
      });
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.failure-alert-outcome" },
  );
}
