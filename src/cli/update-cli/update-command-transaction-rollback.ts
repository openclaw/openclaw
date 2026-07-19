import { resolveGatewayService } from "../../daemon/service.js";
import {
  readRestartSentinel,
  writeRestartSentinelToStateSnapshot,
} from "../../infra/restart-sentinel.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { completePreparedUpdateHandover } from "../../infra/update-handover.js";
import {
  readUpdateRecoveryJournal,
  resolveUpdateRecoveryJournalPath,
  UPDATE_RECOVERY_JOURNAL_ENV,
  UPDATE_RECOVERY_LOCATOR_ENV,
} from "../../infra/update-recovery-journal.js";
import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";
import { restoreRetainedPackageForUpdate } from "../../infra/update-retention.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import {
  restoreUpdateStateSnapshot,
  type UpdateStateSnapshot,
} from "../../infra/update-state-snapshot.js";
import {
  advanceUpdateTransactionMarker,
  claimUpdateTransactionRollback,
} from "../../infra/update-transaction-marker.js";
import type { PreparedPackageUpdateRollback } from "./update-command-package.js";
import {
  serviceControlStdoutForMode,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export async function restoreUpdateStateWithCompletedRollbackMarker(params: {
  snapshot: UpdateStateSnapshot;
  handoffId: string;
  reason: string;
  rollbackOwner: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const recoveryJournalPath = resolveUpdateRecoveryJournalPath(params.env);
  const journal = recoveryJournalPath ? await readUpdateRecoveryJournal(recoveryJournalPath) : null;
  const marker = journal
    ? { payload: journal.committedPayload }
    : await readRestartSentinel(params.env);
  if (
    marker?.payload.stats?.handoffId !== params.handoffId ||
    marker.payload.stats.updateRollbackOwner !== params.rollbackOwner
  ) {
    throw new Error("update rollback marker disappeared before state restoration");
  }
  const restoringPayload = {
    ...marker.payload,
    status: "error" as const,
    stats: {
      ...marker.payload.stats,
      updatePhase: "rolling-back" as const,
      confirmationStatus: "failed" as const,
      reason: params.reason,
    },
  };
  await restoreUpdateStateSnapshot(params.snapshot, {
    prepareStagedState: async (stagedStateDir) => {
      writeRestartSentinelToStateSnapshot(restoringPayload, stagedStateDir);
    },
  });
  const completed = await advanceUpdateTransactionMarker({
    handoffId: params.handoffId,
    phase: "rolled-back",
    rollbackOwner: params.rollbackOwner,
    confirmationStatus: "failed",
    status: "error",
    reason: `update-rollback-completed: ${params.reason}`,
    env: params.env,
  });
  if (!completed) {
    throw new Error("update rollback marker changed before state restoration completed");
  }
}

/** Compensate a prepared package transaction in strict service/package/state order. */
export async function rollbackPreparedPackageUpdate(params: {
  rollback: PreparedPackageUpdateRollback;
  meta: UpdateRestartSentinelMeta;
  result: UpdateRunResult;
  reason: string;
  preManagedServiceStop?: PreManagedServiceStop;
  jsonMode: boolean;
}): Promise<void> {
  const service = resolveGatewayService();
  const rollbackOwner = generateSecureUuid();
  const recoveryLocatorPath = process.env[UPDATE_RECOVERY_LOCATOR_ENV];
  const serviceEnv = {
    ...(params.preManagedServiceStop?.serviceEnv ?? process.env),
    [UPDATE_RECOVERY_JOURNAL_ENV]: params.rollback.recoveryJournalPath,
    ...(recoveryLocatorPath ? { [UPDATE_RECOVERY_LOCATOR_ENV]: recoveryLocatorPath } : {}),
  };
  await completePreparedUpdateHandover({
    confirmationTier: params.meta.confirmationTier ?? "delivery",
    restartService: async () => {
      throw new Error(params.reason);
    },
    waitForHealthy: async () => false,
    waitForConfirmation: async () => false,
    cleanupCompleted: async () => undefined,
    claimRollback: async (reason) => {
      if (!params.meta.handoffId) {
        return false;
      }
      return (
        (await claimUpdateTransactionRollback({
          handoffId: params.meta.handoffId,
          rollbackOwner,
          reason,
          env: serviceEnv,
        })) !== null
      );
    },
    stopService: async () => {
      await service.stop({
        env: serviceEnv,
        stdout: serviceControlStdoutForMode(params.jsonMode),
      });
    },
    restorePackage: async () => {
      await restoreRetainedPackageForUpdate({
        retainedRoot: params.rollback.retainedPackageRoot,
        packageRoot: params.rollback.packageRoot,
      });
    },
    restoreState: async () => {
      if (!params.meta.handoffId) {
        throw new Error("update rollback marker is missing a handoff id");
      }
      await restoreUpdateStateWithCompletedRollbackMarker({
        snapshot: params.rollback.stateSnapshot,
        handoffId: params.meta.handoffId,
        reason: params.reason,
        rollbackOwner,
        env: serviceEnv,
      });
    },
    startService: async () => {
      await service.start({
        env: serviceEnv,
        stdout: serviceControlStdoutForMode(params.jsonMode),
      });
    },
    markFailed: async (reason) => {
      if (!params.meta.handoffId) {
        throw new Error("update rollback marker is missing a handoff id");
      }
      await advanceUpdateTransactionMarker({
        handoffId: params.meta.handoffId,
        phase: "rolling-back",
        rollbackOwner,
        env: serviceEnv,
        confirmationStatus: "failed",
        status: "error",
        reason,
      });
    },
    onPhase: async ({ phase, failureReason }) => {
      if (!params.meta.handoffId) {
        return;
      }
      const markerReason =
        phase === "rolled-back"
          ? `update-rollback-completed: ${failureReason ?? params.reason}`
          : failureReason;
      await advanceUpdateTransactionMarker({
        handoffId: params.meta.handoffId,
        phase,
        rollbackOwner,
        env: serviceEnv,
        ...(phase === "failed" || phase === "rolled-back"
          ? { confirmationStatus: "failed" as const, status: "error" as const }
          : {}),
        ...(markerReason ? { reason: markerReason } : {}),
      });
    },
  });
}
