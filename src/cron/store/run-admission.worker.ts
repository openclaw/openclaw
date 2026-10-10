import type { DatabaseSync } from "node:sqlite";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { retainManualOneShotOccurrence } from "../service/one-shot-schedule.js";
import {
  deleteStaleCronJobFamilyRows,
  loadedCronStoreFromRows,
  loadCronRows,
  updateCronRuntimeRow,
} from "./row-codec.js";
import { markCronDeliveryStartedInDatabase } from "./run-receipt-delivery.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import {
  activateCronRunReceiptInDatabase,
  adjudicateActiveCronRunReceiptInDatabase,
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  isCronRunReceiptOwnerStale,
  ensureCronRunReceiptSchema,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  admitCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
export { releaseCronReservationsInWorker } from "./scheduler-reservation.worker.js";

export function loadRuntimeRows(db: DatabaseSync, storeKey: string, jobIds: Iterable<string>) {
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

export function reserveCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.reserveRuns"]["input"],
): CronRuntimeWorkerOperations["cron.reserveRuns"]["output"] {
  let transactionConflict: CronRunReceiptConflictError | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        try {
          const proposals = new Map(input.proposals.map((proposal) => [proposal.jobId, proposal]));
          const jobIds = [...proposals.keys()].toSorted();
          const { rows, jobs } = loadRuntimeRows(db, input.storeKey, jobIds);
          const receiptSchema = prepareCronRunReceiptWriteSchema(db);
          ensureCronRunReceiptSchema(db);
          const preparation = input.prepared;
          admitCronRuntimeMutation(input.nonce);
          const observed = new Map(
            readActiveCronRunReceiptsInDatabase(db, input.storeKey, jobIds).map((receipt) => [
              receipt.jobId,
              receipt,
            ]),
          );
          const local = new Set(preparation.localReceiptIds);
          const claims = new Map(
            preparation.claims.map((claim) => {
              const receipt = observed.get(claim.handle.jobId);
              return [
                claim.handle.jobId,
                {
                  ...claim,
                  observed: receipt,
                  observedStale: receipt
                    ? isCronRunReceiptOwnerStale(receipt, input.reservedAtMs, local)
                    : false,
                },
              ];
            }),
          );
          const replacements = new Map(
            preparation.replacements.map((receipt) => [receipt.jobId, receipt]),
          );
          for (const jobId of jobIds) {
            if (!replacements.has(jobId)) {
              adjudicateActiveCronRunReceiptInDatabase({
                database: db,
                jobId,
                prepared: claims.get(jobId)!,
                finishedAtMs: input.reservedAtMs,
              });
            }
          }
          const outcome: CronRuntimeMutationContracts["cron.reserveRuns"]["outcome"] = {
            reservations: [],
            replacedReceipts: [],
            liveness: [...claims.values()].flatMap((claim) =>
              claim.observed ? [{ receipt: claim.observed, stale: claim.observedStale }] : [],
            ),
          };
          for (const jobId of jobIds) {
            const job = jobs.get(jobId);
            const row = rows.get(jobId);
            const planned = proposals.get(jobId)!;
            if (
              !job ||
              !row ||
              job.enabled !== planned.enabled ||
              (!planned.immediate && job.state.nextRunAtMs !== planned.nextRunAtMs) ||
              job.state.lastRunAtMs !== planned.lastRunAtMs ||
              job.state.lastRunStatus !== planned.lastRunStatus ||
              job.state.queuedAtMs !== undefined ||
              job.state.runningAtMs !== undefined ||
              resolveCronJobConfigRevision(job) !== planned.configRevision
            ) {
              continue;
            }
            const prior = replacements.get(jobId);
            if (prior) {
              finishCronRunReceiptInDatabase({
                database: db,
                receiptSchema,
                handle: prior,
                status: "superseded",
                finishedAtMs: input.reservedAtMs,
                error: "cron reservation replaced before activation",
              });
              outcome.replacedReceipts.push(prior);
            }
            const runReceipt = claimCronRunReceiptInDatabase({
              database: db,
              receiptSchema,
              prepared: claims.get(jobId)!,
              resolveAgentId: (current) =>
                resolveCronJobEffectiveAgentId(current, preparation.defaultAgentId),
            });
            const previousEnabled = job.enabled ?? true;
            if (input.onExit) {
              job.enabled = false;
              job.updatedAtMs = input.reservedAtMs;
              job.state.scheduleActivatedAtMs = input.reservedAtMs;
              delete job.state.nextRunAtMs;
              delete job.state.startupCatchupAtMs;
              delete job.state.pacedNextRunAtMs;
              delete job.state.forcePreservedNextRunAtMs;
            } else if (input.preserveSchedule) {
              retainManualOneShotOccurrence(job, input.scheduleOwnershipAtMs);
            }
            job.state.queuedAtMs = input.reservedAtMs;
            updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
            outcome.reservations.push({ job, runReceipt });
          }
          return retainCronRuntimeMutationOutcome("cron.reserveRuns", db, input.nonce, outcome);
        } catch (error) {
          if (error instanceof CronRunReceiptConflictError) {
            transactionConflict = error;
          }
          throw error;
        }
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "cron.run-reservation" },
    );
  } catch (error) {
    if (!transactionConflict || error !== transactionConflict) {
      throw error;
    }
    assertTransactionUsable(database.db);
    if (!database.db.isOpen || database.db.isTransaction) {
      throw error;
    }
    // This result describes a rolled-back transaction; it carries no commit receipt.
    return { nonce: input.nonce, conflict: transactionConflict.receipt };
  }
}

export function activateCronRunInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.activateRun"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, jobs } = loadRuntimeRows(db, input.storeKey, [input.handle.jobId]);
      const current = jobs.get(input.handle.jobId);
      const preparation = input.prepared;
      admitCronRuntimeMutation(input.nonce);
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
          updateCronRuntimeRow(db, input.storeKey, current);
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

export function markCronDeliveryStartedInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.markDeliveryStarted"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (input.storeKey !== input.handle.storeKey) {
        throw new CronRunReceiptRevisionError(input.handle.receiptId);
      }
      const deletionBlocked = isAgentDeletionBlocked(input.handle.agentId, {}, db);
      const preparation = input.prepared;
      admitCronRuntimeMutation(input.nonce);
      if (deletionBlocked) {
        throw new CronRunReceiptRevisionError(
          input.handle.receiptId,
          describeUnavailableCronAgent(input.handle.agentId),
          "owner-unavailable",
        );
      }
      markCronDeliveryStartedInDatabase({
        database: db,
        handle: input.handle,
        allowMissingJob: preparation.allowMissingJob,
        resolveAgentId: (job) => resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
      });
      return retainCronRuntimeMutationOutcome("cron.markDeliveryStarted", db, input.nonce, {});
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.mark-delivery-started" },
  );
}

export function finishCronReceiptInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finishReceipt"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      admitCronRuntimeMutation(input.nonce);
      finishCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        ...input.terminal,
      });
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
      admitCronRuntimeMutation(input.nonce);
      const removed = deleteStaleCronJobFamilyRows(db, input.storeKey, input.family);
      return retainCronRuntimeMutationOutcome("cron.removeStaleFamily", db, input.nonce, {
        removed,
      });
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.job-family-adoption" },
  );
}
