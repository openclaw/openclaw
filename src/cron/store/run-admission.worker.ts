import type { DatabaseSync } from "node:sqlite";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { recomputeJobNextRunAtMs } from "../service/jobs-scheduling.js";
import { retainManualOneShotOccurrence } from "../service/one-shot-schedule.js";
import type { CronJobPolicyContext } from "../service/state.js";
import {
  deleteCronJobRowInDatabase,
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
  assertCronRunReceiptCurrentInDatabase,
  assertCronRunReceiptOwnedInDatabase,
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  ensureCronRunReceiptSchema,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  createCronMutationLogger,
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import { releaseSchedulerReservationsInWorker } from "./scheduler-reservation.worker.js";

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
          const preparation = prepareCronRuntimeMutation("cron.reserveRuns", input.nonce, {
            receipts: readActiveCronRunReceiptsInDatabase(db, input.storeKey, jobIds),
          });
          const claims = new Map(preparation.claims.map((claim) => [claim.handle.jobId, claim]));
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

export function releaseCronReservationsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.releaseReservations"]["input"],
) {
  const { policy } = input;
  if (policy.kind !== "general") {
    return releaseSchedulerReservationsInWorker(database, { ...input, policy });
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, jobs } = loadRuntimeRows(db, input.storeKey, input.jobIds);
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const preparation = prepareCronRuntimeMutation("cron.releaseReservations", input.nonce, {
        notificationNeedsDefault: false,
        deletionBlocked:
          policy.requireCurrentReceipt === true &&
          policy.terminal !== undefined &&
          isAgentDeletionBlocked(policy.terminal.handle.agentId, {}, db),
      });
      const outcome: CronRuntimeMutationContracts["cron.releaseReservations"]["outcome"] = {
        jobs: [],
        notifications: [],
        logs: [],
      };
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => preparation.nowMs,
          log: createCronMutationLogger(outcome.logs),
        },
      };
      if (policy.requireCurrentReceipt && policy.terminal) {
        assertCronRunReceiptCurrentInDatabase({
          database: db,
          handle: policy.terminal.handle,
          resolveAgentId: (job) => resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
        });
      }
      for (const reservation of preparation.reservations) {
        if (!policy.terminal) {
          finishCronRunReceiptInDatabase({
            database: db,
            receiptSchema,
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
        const previousEnabled = job.enabled ?? true;
        if (policy.restoreLastError && reservation.activationPreviousLastError) {
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
        if (policy.recompute && job.enabled && job.state.nextRunAtMs === undefined) {
          recomputeJobNextRunAtMs({
            state,
            job,
            nowMs: preparation.nowMs,
            deferredNotifications: outcome.notifications,
          });
        }
        updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
        outcome.jobs.push(job);
      }
      if (policy.terminal && !preparation.deferTerminal) {
        finishCronRunReceiptInDatabase({ database: db, receiptSchema, ...policy.terminal });
      }
      return retainCronRuntimeMutationOutcome("cron.releaseReservations", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-reservation-cleanup" },
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
      const preparation = prepareCronRuntimeMutation("cron.markDeliveryStarted", input.nonce, {
        deletionBlocked,
      });
      if (deletionBlocked) {
        throw new CronRunReceiptRevisionError(
          input.handle.receiptId,
          "cron agent is unavailable",
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
      prepareCronRuntimeMutation("cron.finishReceipt", input.nonce, {});
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

/** Job state and its terminal receipt share the same authoritative write transaction. */
export function finalizeCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finalizeRuns"]["input"],
): CronRuntimeWorkerOperations["cron.finalizeRuns"]["output"] {
  let transactionRefusal: CronRunReceiptRevisionError | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        try {
          const { rows, jobs } = loadRuntimeRows(db, input.storeKey, input.jobIds);
          const receiptSchema = prepareCronRunReceiptWriteSchema(db);
          const preparation = prepareCronRuntimeMutation("cron.finalizeRuns", input.nonce, {
            jobs: [...jobs.values()],
            receipts: input.receipts.map(({ terminal }) => ({
              receiptId: terminal.handle.receiptId,
              deletionBlocked: isAgentDeletionBlocked(terminal.handle.agentId, {}, db),
              triggerStateRetired: isCronRunTriggerStateRetiredInDatabase({
                database: db,
                handle: terminal.handle,
              }),
            })),
          });
          for (const { terminal, allowMissingJob } of input.receipts) {
            if (allowMissingJob) {
              assertCronRunReceiptOwnedInDatabase({ database: db, handle: terminal.handle });
            } else {
              assertCronRunReceiptCurrentInDatabase({
                database: db,
                handle: terminal.handle,
                resolveAgentId: (job) =>
                  resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
              });
            }
          }
          const deleted = new Set(preparation.deletedJobIds);
          for (const jobId of deleted) {
            if (!input.jobIds.includes(jobId)) {
              throw new Error("Cron finalization attempted to delete an unrelated job");
            }
            deleteCronJobRowInDatabase(db, input.storeKey, jobId);
          }
          for (const job of preparation.jobs) {
            const row = rows.get(job.id);
            if (row && !deleted.has(job.id)) {
              updateCronRuntimeRow(db, input.storeKey, job, jobs.get(job.id)?.enabled ?? true);
            }
          }
          for (const { terminal } of input.receipts) {
            if (!preparation.deferredReceiptIds.includes(terminal.handle.receiptId)) {
              finishCronRunReceiptInDatabase({ database: db, receiptSchema, ...terminal });
            }
          }
          return retainCronRuntimeMutationOutcome("cron.finalizeRuns", db, input.nonce, {
            changed: preparation.jobs.length > 0 || deleted.size > 0,
          });
        } catch (error) {
          if (error instanceof CronRunReceiptRevisionError) {
            transactionRefusal = error;
          }
          throw error;
        }
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "cron.run-finalization" },
    );
  } catch (error) {
    if (!transactionRefusal || error !== transactionRefusal) {
      throw error;
    }
    assertTransactionUsable(database.db);
    if (!database.db.isOpen || database.db.isTransaction) {
      throw error;
    }
    // Preserve domain identity only after rollback, never through an uncertain write failure.
    return {
      nonce: input.nonce,
      receiptRevision: {
        receiptId: transactionRefusal.receiptId,
        message: transactionRefusal.message,
        reason: transactionRefusal.reason,
      },
    };
  }
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
