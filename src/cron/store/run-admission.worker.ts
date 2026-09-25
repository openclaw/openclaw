import type { DatabaseSync } from "node:sqlite";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { recomputeJobNextRunAtMs } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext, Logger } from "../service/state.js";
import {
  deleteStaleCronJobFamilyRows,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "./row-codec.js";
import {
  activateCronRunReceiptInDatabase,
  assertCronRunReceiptCurrentInDatabase,
  CronRunReceiptRevisionError,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
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

function loadRuntimeRows(db: DatabaseSync, storeKey: string, jobIds: Iterable<string>) {
  const rows = loadCronRows(db, storeKey, new Set(jobIds), {
    includeGrantDefinitionProjection: true,
  });
  const jobs = loadedCronStoreFromRows(rows).store.jobs;
  const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey, jobs });
  if (repairJobIds.length > 0) {
    repairCronRuntimeAuthorityRows({ db, storeKey, jobs, jobIds: repairJobIds });
  }
  return {
    rows: new Map(rows.map((row) => [row.job_id, row])),
    jobs: new Map(jobs.map((job) => [job.id, job])),
  };
}

export function activateCronRunInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.activateRun"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, jobs } = loadRuntimeRows(db, input.storeKey, [input.handle.jobId]);
      const current = jobs.get(input.handle.jobId);
      const preparation = prepareCronRuntimeMutation("cron.activateRun", input.nonce, {});
      const outcome: CronRuntimeMutationContracts["cron.activateRun"]["outcome"] = {};
      const row = rows.get(input.handle.jobId);
      const matchesExit =
        !input.onExitSchedule ||
        (current?.schedule.kind === "on-exit" &&
          current.schedule.command === input.onExitSchedule.command &&
          current.schedule.cwd === input.onExitSchedule.cwd);
      if (current && row && current.state.queuedAtMs === preparation.markerAtMs && matchesExit) {
        try {
          const receipt = activateCronRunReceiptInDatabase({
            database: db,
            handle: input.handle,
            startedAtMs: input.startedAtMs,
            resolveAgentId: (job) =>
              resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
          });
          outcome.activation = {
            job: current,
            receipt,
            previousLastError: current.state.lastError,
          };
          delete current.state.queuedAtMs;
          current.state.runningAtMs = input.startedAtMs;
          current.state.runningReceiptId = receipt.receiptId;
          delete current.state.runningScheduleChangeId;
          current.state.lastError = undefined;
          upsertCronJobRow(db, input.storeKey, current, row.sort_order, { knownExistingRow: row });
        } catch (error) {
          if (!(error instanceof CronRunReceiptRevisionError)) {
            throw error;
          }
        }
      }
      return retainCronRuntimeMutationOutcome("cron.activateRun", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-activation" },
  );
}

export function releaseCronReservationsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.releaseReservations"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, jobs } = loadRuntimeRows(db, input.storeKey, input.jobIds);
      const preparation = prepareCronRuntimeMutation("cron.releaseReservations", input.nonce, {
        deletionBlocked:
          input.requireCurrentReceipt === true &&
          input.terminal !== undefined &&
          isAgentDeletionBlocked(input.terminal.handle.agentId, {}, db),
      });
      const outcome: CronRuntimeMutationContracts["cron.releaseReservations"]["outcome"] = {
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
      if (input.requireCurrentReceipt && input.terminal) {
        assertCronRunReceiptCurrentInDatabase({
          database: db,
          handle: input.terminal.handle,
          resolveAgentId: (job) => resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
        });
      }
      for (const reservation of preparation.reservations) {
        if (!input.terminal) {
          finishCronRunReceiptInDatabase({
            database: db,
            handle: reservation.runReceipt,
            status: "skipped",
            finishedAtMs: preparation.nowMs,
            error: "cron reservation released before completion",
          });
        }
        const job = jobs.get(reservation.jobId);
        const row = rows.get(reservation.jobId);
        if (!job || !row) {
          continue;
        }
        const queuedMatches = reservation.markerAtMs === job.state.queuedAtMs;
        const runningMatches = reservation.markerAtMs === job.state.runningAtMs;
        if (!queuedMatches && !runningMatches) {
          continue;
        }
        if (input.restoreLastError && reservation.activationPreviousLastError) {
          job.state.lastError = reservation.activationPreviousLastError.value;
        }
        if (queuedMatches) {
          delete job.state.queuedAtMs;
        }
        if (runningMatches) {
          delete job.state.runningAtMs;
          delete job.state.runningReceiptId;
          delete job.state.runningScheduleChangeId;
        }
        if (input.recompute && job.enabled && job.state.nextRunAtMs === undefined) {
          recomputeJobNextRunAtMs({
            state,
            job,
            nowMs: preparation.nowMs,
            deferredNotifications: outcome.notifications,
          });
        }
        upsertCronJobRow(db, input.storeKey, job, row.sort_order, { knownExistingRow: row });
        outcome.jobs.push(job);
      }
      if (input.terminal && !preparation.deferTerminal) {
        finishCronRunReceiptInDatabase({ database: db, ...input.terminal });
      }
      return retainCronRuntimeMutationOutcome("cron.releaseReservations", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-reservation-cleanup" },
  );
}

export function finishCronReceiptInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finishReceipt"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      prepareCronRuntimeMutation("cron.finishReceipt", input.nonce, {});
      finishCronRunReceiptInDatabase({ database: db, ...input.terminal });
      return retainCronRuntimeMutationOutcome("cron.finishReceipt", db, input.nonce, {});
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.finish" },
  );
}

export function removeStaleCronFamilyInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.removeStaleFamily"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      prepareCronRuntimeMutation("cron.removeStaleFamily", input.nonce, {});
      const removed = deleteStaleCronJobFamilyRows(db, input.storeKey, input.family);
      return retainCronRuntimeMutationOutcome("cron.removeStaleFamily", db, input.nonce, {
        removed,
      });
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.job-family-adoption" },
  );
}
