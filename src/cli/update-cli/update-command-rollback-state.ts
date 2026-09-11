import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../../infra/update-recovery-backup.js";
import {
  recordUpdateRunRecoveryCapture,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { CommandProcessScopeUnsettledError } from "../../process/exec-spawn.js";
import { UpdateDoctorProcessUnsettledError } from "./update-command-fresh-doctor.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";

/** The caller owns stopped writers and joined children; this operation never starts a Gateway. */
export async function restoreUpdateRecoveryState(
  backup: UpdateRecoveryBackupRef,
  authority: { assertOwned: () => void },
): Promise<{ warnings: string[] }> {
  const manifest = await verifyUpdateRecoveryBackup(backup);
  authority.assertOwned();
  try {
    await restoreUpdateRecoveryBackup(backup, authority);
  } catch (cause) {
    throw new Error(
      `State restore failed; capture retained at ${backup.manifestPath}. Keep the Gateway stopped and run npx openclaw@latest doctor --fix. ${formatErrorMessage(cause)}`,
      { cause },
    );
  }
  const warnings: string[] = [];
  const report = async (operation: () => void | Promise<void>) => {
    authority.assertOwned();
    try {
      await operation();
    } catch (error) {
      authority.assertOwned();
      warnings.push(
        `State restored; recovery reporting failed at ${backup.manifestPath}: ${formatErrorMessage(error)}. Inspect with openclaw update status --json.`,
      );
    }
  };
  await report(() => {
    recordUpdateRunRecoveryCapture(
      manifest.runId,
      { manifestSha256: backup.manifestSha256, restored: true },
      authority.assertOwned,
    );
  });
  await report(() => {
    recordUpdateRunStep(manifest.runId, {
      step: "state rollback",
      status: "completed",
      endedAtMs: Date.now(),
      detail: backup.manifestPath,
    });
  });
  await report(() => writeUpdateRecoveryBackupOutcome(backup, { status: "restored" }, authority));
  return { warnings };
}

/** Wrapping failures must not erase the child-lifetime boundary. */
export function hasUnsettledUpdateProcesses(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) =>
      candidate instanceof UpdateDoctorProcessUnsettledError ||
      candidate instanceof CommandProcessScopeUnsettledError,
  );
}

/** Unjoined processes can still mutate state; restoration cannot race them. */
export function refuseUnsettledUpdateProcesses(
  error: unknown,
  result: UpdateRunResult,
  backup?: UpdateRecoveryBackupRef,
): void {
  if (hasUnsettledUpdateProcesses(error)) {
    throw new UpdateCommandPendingRecoveryFailure(
      {
        ...(error instanceof UpdateCommandFailure ? error.result : result),
        status: "error",
        reason: "update-processes-unsettled",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
      `${formatErrorMessage(error)} Capture retained at ${backup?.manifestPath ?? "its recorded path"}; keep the Gateway stopped and run npx openclaw@latest doctor --fix after the child exits.`,
      { cause: error },
    );
  }
}
