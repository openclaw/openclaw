import path from "node:path";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { tryGetLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  completeLegacyDefaultCronOwnerHandoff,
  readRetainedLegacyDefaultCronOwnerForStore,
  restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase,
  restoreRetainedLegacyDefaultCronOwnerHandoffForStore,
  retainLegacyDefaultCronOwnerHandoffForStore,
  type RetainedLegacyCronOwnerHandoffSnapshot,
} from "../legacy-default-agent-owner-handoff.js";
import { materializeLegacyDefaultCronJobOwners } from "../legacy-default-agent-owner-migration.js";
import { resolveCronJobsStorePathFromConfig } from "../store.js";
import {
  materializeCronJobsStoreOwners,
  mergePreparedCronOwnerRollbacks,
  rollbackMaterializedCronJobsStoreOwners,
} from "../store/owner-migration.js";
import type { PreparedCronOwnerRollback } from "../store/owner-migration.js";
import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { nextWakeAtMs, recomputeNextRunsForMaintenance } from "./jobs.js";
import { acquireCronOperationLock, locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { resolveCurrentDefaultAgentId } from "./ops-shared.js";
import { prepareReloadedCronJobsForScheduling } from "./reload-scheduling.js";
import { cancelCronRunAdmissionWaiters } from "./run-admission.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
  STARTUP_INTERRUPTED_ERROR,
} from "./startup-run-repair.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import { tryFindCronTaskRunIdForRecovery, tryFindFinalizedCronTaskRun } from "./task-runs.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

function retainedReceiptMatches(
  left: RetainedLegacyCronOwnerHandoffSnapshot,
  right: RetainedLegacyCronOwnerHandoffSnapshot,
): boolean {
  return left?.agentId === right?.agentId && left?.status === right?.status;
}

async function materializeLoadedLegacyDefaultAgentOwners(
  state: CronServiceState,
  legacyDefaultAgentId: string,
  options?: {
    expectedStoreEpoch?: () => number | undefined;
    recordCommittedStoreEpoch?: (storeEpoch: number) => void;
    recordPreparedRollback?: (rollback: PreparedCronOwnerRollback) => void;
  },
) {
  const jobs = state.store?.jobs ?? [];
  return await materializeLegacyDefaultCronJobOwners({
    storePath: state.deps.storePath,
    legacyDefaultAgentId,
    records: jobs as unknown as Array<Record<string, unknown>>,
    persistRecords: async (records) => {
      let candidateRecords = records;
      const requiredStoreEpoch = options?.expectedStoreEpoch?.();
      if (requiredStoreEpoch !== undefined && state.storeEpoch !== requiredStoreEpoch) {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        if (state.storeEpoch !== requiredStoreEpoch) {
          throw new Error("cron store changed after rollback snapshot; retry config write");
        }
        candidateRecords = (state.store?.jobs ?? []) as unknown as Array<Record<string, unknown>>;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expectedStoreEpoch = requiredStoreEpoch ?? state.storeEpoch;
        const persisted = await materializeCronJobsStoreOwners({
          storePath: state.deps.storePath,
          legacyDefaultAgentId,
          records: candidateRecords as unknown as CronJob[],
          legacyImportedJobIds: state.legacyImportedJobIds,
          expectedStoreEpoch,
          recordCommittedStoreEpoch: options?.recordCommittedStoreEpoch,
          recordPreparedRollback: options?.recordPreparedRollback,
          env: state.deps.env,
        });
        if (persisted.matched) {
          for (const record of candidateRecords) {
            if (typeof record.id === "string") {
              state.legacyImportedJobIds.delete(record.id);
            }
          }
          return persisted.rewritten;
        }
        if (requiredStoreEpoch !== undefined) {
          throw new Error("cron store changed after rollback snapshot; retry config write");
        }
        if (attempt === 1) {
          throw new Error("cron store changed during legacy owner migration twice; retry startup");
        }
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        candidateRecords = (state.store?.jobs ?? []) as unknown as Array<Record<string, unknown>>;
      }
      return 0;
    },
  });
}

/** Locks mutations after materializing the loaded store until the topology commit settles. */
export async function beginLegacyDefaultAgentOwnerHandoff(
  state: CronServiceState,
  legacyDefaultAgentId: string,
  options?: {
    beforeMigration?: () => Promise<void>;
    expectedStoreEpoch?: () => number | undefined;
    recordCommittedStoreEpoch?: (storeEpoch: number) => void;
    recordPreparedRollback?: (rollback: PreparedCronOwnerRollback) => void;
  },
) {
  const release = await acquireCronOperationLock(state);
  try {
    await options?.beforeMigration?.();
    await ensureLoaded(state, { skipRecompute: true });
    const migration = await materializeLoadedLegacyDefaultAgentOwners(
      state,
      legacyDefaultAgentId,
      options,
    );
    await refreshLegacyDefaultAgentOwnerHandoff(state);
    return { migration, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Reloads one sealed service and schedules only jobs newly imported during the handoff. */
export async function refreshLegacyDefaultAgentOwnerHandoff(
  state: CronServiceState,
  options?: {
    persistSchedulingState?: boolean;
  },
) {
  await ensureLoaded(state, { forceReload: true, skipRecompute: true });
  const scheduledNewJob = prepareReloadedCronJobsForScheduling(state);
  if (scheduledNewJob && options?.persistSchedulingState !== false) {
    await persist(state, { stateOnly: true });
  }
  armTimer(state);
}

/** Replaces stale in-memory rows before a Gateway publishes new agent resolution. */
export async function reloadForConfigAdoption(
  state: CronServiceState,
  incomingConfig: OpenClawConfig,
) {
  const release = await acquireCronOperationLock(state);
  try {
    state.pendingConfigAdoption = {
      legacyDefaultAgentId: state.deps.legacyDefaultAgentId,
    };
    const pendingAdoption = state.pendingConfigAdoption;
    await ensureLoaded(state, { skipRecompute: true });
    const incomingStorePath = resolveCronJobsStorePathFromConfig(incomingConfig, state.deps.env);
    const currentRetainedOwner = readRetainedLegacyDefaultCronOwnerForStore(
      state.deps.storePath,
      state.deps.env,
    );
    const incomingRetainedOwner =
      path.resolve(incomingStorePath) === path.resolve(state.deps.storePath)
        ? currentRetainedOwner
        : readRetainedLegacyDefaultCronOwnerForStore(incomingStorePath, state.deps.env);
    const runtimeLegacyOwner =
      state.deps.legacyDefaultAgentId ?? resolveCurrentDefaultAgentId(state);
    const currentStoreOwner = currentRetainedOwner ?? runtimeLegacyOwner;
    const incomingStoreOwner = incomingRetainedOwner ?? runtimeLegacyOwner;
    const incomingAgentIds = new Set(listAgentIds(incomingConfig).map(normalizeAgentId));
    if (currentStoreOwner && incomingAgentIds.has(normalizeAgentId(currentStoreOwner))) {
      if (!currentRetainedOwner) {
        retainLegacyDefaultCronOwnerHandoffForStore(
          state.deps.storePath,
          currentStoreOwner,
          state.deps.env,
        );
      }
      const migration = await materializeLoadedLegacyDefaultAgentOwners(state, currentStoreOwner);
      if (migration.warnings.length > 0) {
        throw new Error(migration.warnings.join("\n"));
      }
      if (
        !currentRetainedOwner ||
        normalizeAgentId(currentRetainedOwner) === normalizeAgentId(currentStoreOwner)
      ) {
        completeLegacyDefaultCronOwnerHandoff(
          state.deps.storePath,
          currentStoreOwner,
          state.deps.env,
        );
      }
    }
    if (
      path.resolve(incomingStorePath) !== path.resolve(state.deps.storePath) &&
      incomingStoreOwner &&
      incomingAgentIds.has(normalizeAgentId(incomingStoreOwner))
    ) {
      const durableRollback: {
        legacyMigrationReceiptCreated: boolean;
        legacyMigrationSource?: import("../../commands/doctor/cron/legacy-store-migration.js").LegacyCronMigrationSource;
        prepared?: PreparedCronOwnerRollback;
        receiptAfter?: RetainedLegacyCronOwnerHandoffSnapshot;
        receiptBefore?: RetainedLegacyCronOwnerHandoffSnapshot;
        receiptCaptured: boolean;
      } = { legacyMigrationReceiptCreated: false, receiptCaptured: false };
      pendingAdoption.rollbackDurableAdoption = async () => {
        const restoreMigrationReceipt = durableRollback.legacyMigrationReceiptCreated
          ? (await import("../../commands/doctor/cron/migration-ledger.js"))
              .rollbackLegacyCronMigrationReceiptInDatabase
          : undefined;
        if (durableRollback.prepared) {
          await rollbackMaterializedCronJobsStoreOwners({
            rollback: durableRollback.prepared,
            restoreMetadata: (db) => {
              if (durableRollback.receiptCaptured) {
                restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase(
                  db,
                  incomingStorePath,
                  durableRollback.receiptBefore,
                  { expectedCurrent: durableRollback.receiptAfter },
                );
              }
              if (restoreMigrationReceipt && durableRollback.legacyMigrationSource) {
                restoreMigrationReceipt(db, durableRollback.legacyMigrationSource);
              }
            },
            env: state.deps.env,
          });
        } else if (durableRollback.receiptCaptured) {
          restoreRetainedLegacyDefaultCronOwnerHandoffForStore(
            incomingStorePath,
            durableRollback.receiptBefore,
            state.deps.env,
            { expectedCurrent: durableRollback.receiptAfter },
          );
        }
        // Durable restoration is non-idempotent. Disarm it before the later live
        // scheduler refresh so a refresh failure can be retried safely.
        pendingAdoption.rollbackDurableAdoption = undefined;
      };
      if (!incomingRetainedOwner) {
        const receiptMutation = retainLegacyDefaultCronOwnerHandoffForStore(
          incomingStorePath,
          incomingStoreOwner,
          state.deps.env,
        );
        durableRollback.receiptBefore = receiptMutation.before;
        durableRollback.receiptAfter = receiptMutation.after;
        durableRollback.receiptCaptured = true;
      }
      const {
        loadLegacyCronRepairState,
        materializeLegacyDefaultCronJobOwners: repairLegacyDefaultCronJobOwners,
      } = await import("../../commands/doctor/cron/legacy-repair.js");
      const repairState = await loadLegacyCronRepairState({
        cfg: incomingConfig,
        storePath: incomingStorePath,
        env: state.deps.env,
        readOnly: true,
      });
      durableRollback.legacyMigrationSource = repairState?.legacyMigrationSource;
      const incomingMigration = await repairLegacyDefaultCronJobOwners({
        cfg: incomingConfig,
        storePath: incomingStorePath,
        legacyDefaultAgentId: incomingStoreOwner,
        env: state.deps.env,
        repairState,
        recordPreparedRollback: (prepared) => {
          durableRollback.prepared = mergePreparedCronOwnerRollbacks(
            durableRollback.prepared,
            prepared,
          );
        },
        recordLegacyReceiptCreated: () => {
          durableRollback.legacyMigrationReceiptCreated = true;
        },
      });
      if (incomingMigration.warnings.length > 0) {
        throw new Error(incomingMigration.warnings.join("\n"));
      }
      if (
        !incomingRetainedOwner ||
        normalizeAgentId(incomingRetainedOwner) === normalizeAgentId(incomingStoreOwner)
      ) {
        const receiptMutation = completeLegacyDefaultCronOwnerHandoff(
          incomingStorePath,
          incomingStoreOwner,
          state.deps.env,
        );
        if (!durableRollback.receiptCaptured) {
          durableRollback.receiptBefore = receiptMutation.before;
          durableRollback.receiptCaptured = true;
        } else if (!retainedReceiptMatches(receiptMutation.before, durableRollback.receiptAfter)) {
          // Another process replaced the receipt between retain and complete. Its
          // transaction-owned before-image is now the state rejection must preserve.
          durableRollback.receiptBefore = receiptMutation.before;
        }
        durableRollback.receiptAfter = receiptMutation.after;
      }
    }
    await refreshLegacyDefaultAgentOwnerHandoff(state);
  } finally {
    release();
  }
}

/** Publishes the retained owner from the config only after the caller adopts it. */
export function completeConfigAdoption(state: CronServiceState, incomingConfig: OpenClawConfig) {
  state.deps.legacyDefaultAgentId = tryGetLegacyDefaultAgentId(incomingConfig);
  state.pendingConfigAdoption = undefined;
}

/** Restores the durable scheduler snapshot after a config candidate is rejected. */
export async function rejectConfigAdoption(state: CronServiceState) {
  const pending = state.pendingConfigAdoption;
  if (!pending) {
    return;
  }
  const release = await acquireCronOperationLock(state);
  try {
    await pending.rollbackDurableAdoption?.();
    state.deps.legacyDefaultAgentId = pending.legacyDefaultAgentId;
    await refreshLegacyDefaultAgentOwnerHandoff(state);
    state.pendingConfigAdoption = undefined;
  } finally {
    release();
  }
}

/** Starts the cron service, recovers interrupted runs, catches up missed jobs, and arms the timer. */
export async function start(state: CronServiceState) {
  state.stopped = false;
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedJobIds = new Set<string>();
  const interruptedRuns: InterruptedStartupRun[] = [];
  const completedJobIdsToDelete = new Set<string>();
  let repairedAnyStartupRun = false;
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const retainedStoreOwner = readRetainedLegacyDefaultCronOwnerForStore(
      state.deps.storePath,
      state.deps.env,
    );
    const legacyDefaultAgentId = retainedStoreOwner ?? state.deps.legacyDefaultAgentId;
    // A removed/renamed owner is not a valid historical replacement: leave rows
    // ownerless and keep the receipt pending until a later roster can adopt it safely.
    const legacyOwnerEligible =
      legacyDefaultAgentId !== undefined &&
      state.deps.isAgentAvailable?.(normalizeAgentId(legacyDefaultAgentId)) !== false;
    if (legacyDefaultAgentId && legacyOwnerEligible) {
      const migration = await materializeLoadedLegacyDefaultAgentOwners(
        state,
        legacyDefaultAgentId,
      );
      if (migration.warnings.length > 0) {
        throw new Error(migration.warnings.join("\n"));
      }
      for (const change of migration.changes) {
        state.deps.log.info({ storePath: state.deps.storePath }, `cron: ${change}`);
      }
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      if (
        retainedStoreOwner &&
        normalizeAgentId(retainedStoreOwner) === normalizeAgentId(legacyDefaultAgentId)
      ) {
        completeLegacyDefaultCronOwnerHandoff(
          state.deps.storePath,
          retainedStoreOwner,
          state.deps.env,
        );
      }
    }
    if (state.stopped) {
      return;
    }
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        state.deps.log.info(
          { jobId: job.id, queuedAtMs: job.state.queuedAtMs },
          "cron: releasing queued job reservation on startup",
        );
        job.state.queuedAtMs = undefined;
        repairedAnyStartupRun = true;
      }
      if (typeof job.state.runningAtMs === "number") {
        // Older releases used runningAtMs for both queued and active work. Those
        // rows are intentionally recovered conservatively to avoid replaying side effects.
        const runningAtMs = job.state.runningAtMs;
        const taskRunId = tryFindCronTaskRunIdForRecovery(state, job.id, runningAtMs);
        const finalized = tryFindFinalizedCronTaskRun(state, job.id, runningAtMs);
        if (finalized) {
          const repaired = restoreFinalizedStartupRun({
            state,
            job,
            runningAtMs,
            entry: finalized.entry,
            ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
            ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
          });
          // Skip only the old invocation; a distinct overdue replacement
          // must remain eligible for normal one-shot startup catch-up.
          if (repaired.replacementAtMs === undefined) {
            interruptedJobIds.add(job.id);
          }
          if (repaired.shouldDelete) {
            completedJobIdsToDelete.add(job.id);
          }
          repairedAnyStartupRun = true;
          continue;
        }
        const nowMs = state.deps.nowMs();
        const interrupted = markInterruptedStartupRun({
          state,
          job,
          taskRunId,
          runningAtMs,
          nowMs,
        });
        if (interrupted.replacementAtMs === undefined) {
          interruptedJobIds.add(job.id);
        }
        interruptedRuns.push(interrupted);
        repairedAnyStartupRun = true;
      }
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    if (repairedAnyStartupRun || jobs.length > 0) {
      await persist(state, repairedAnyStartupRun ? undefined : { stateOnly: true });
    }
  });

  if (state.stopped) {
    return;
  }
  await runMissedJobs(state, {
    skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : undefined,
    deferAgentTurnJobs: true,
  });

  await locked(state, async () => {
    // Startup catch-up already persisted the latest in-memory store state, and
    // this path runs before the scheduler begins servicing regular timer ticks.
    // Avoid an extra reload/write cycle on startup.
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    const changed = recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
    if (changed) {
      await persist(state);
    }
    for (const interrupted of interruptedRuns) {
      const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
      emitCronRunFinished(
        state,
        {
          jobId: interrupted.jobId,
          action: "finished",
          job,
          status: "error",
          error: STARTUP_INTERRUPTED_ERROR,
          delivered: false,
          deliveryStatus: "unknown",
          deliveryError: STARTUP_INTERRUPTED_ERROR,
          failureNotificationDelivery: job
            ? failureNotificationDeliveryFromJobState(job)
            : undefined,
          runAtMs: interrupted.runAtMs,
          durationMs: interrupted.durationMs,
          nextRunAtMs: job?.state.nextRunAtMs,
        },
        undefined,
        interrupted.taskRunId,
      );
    }
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  state.stopped = true;
  cancelCronRunAdmissionWaiters(state);
  state.schedulerStarted = false;
  stopTimer(state);
}

/** Temporarily stops automatic ticks without running startup recovery on resume. */
export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  stopTimer(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (!state.schedulerStarted) {
    return;
  }
  try {
    armTimer(state);
  } catch (err) {
    // armTimer can install a timer before a later dependency throws. Roll the
    // whole transition back so a suspension retry cannot reopen without cron.
    state.schedulingPaused = true;
    stopTimer(state);
    throw err;
  }
}
