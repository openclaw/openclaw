import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  preserveUpdateRecoveryCandidate,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../../infra/update-recovery-backup.js";
import { UpdateRecoveryPublicationUnavailableError } from "../../infra/update-recovery-publication.js";
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

/** State admission precedes the first reverse package replacement. */
export async function prepareUpdateRecoveryRollback(
  backup: UpdateRecoveryBackupRef | undefined,
  assertOwned: () => void,
): Promise<void> {
  if (!backup) {
    return;
  }
  const [{ beginDoctorMaintenance }, { defaultRuntime }] = await Promise.all([
    import("../../commands/doctor-maintenance.js"),
    import("../../runtime.js"),
  ]);
  assertOwned();
  const maintenance = await beginDoctorMaintenance({
    root: null,
    options: { repair: true },
    runtime: defaultRuntime,
  });
  if (!maintenance) {
    throw new Error("Candidate preservation requires offline state maintenance.");
  }
  const authority = {
    assertOwned() {
      assertOwned();
      maintenance.assertCurrent();
    },
  };
  let failure: { error: unknown } | undefined;
  try {
    authority.assertOwned();
    const candidate = await preserveUpdateRecoveryCandidate(backup, authority);
    const { assertUpdateRecoveryPublicationPrepared } =
      await import("../../infra/update-recovery-publication.js");
    await assertUpdateRecoveryPublicationPrepared(backup, candidate, authority);
  } catch (error) {
    failure = { error };
  }
  try {
    await maintenance.release();
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure.error, error],
        "Candidate preservation and physical maintenance settlement failed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (failure) {
    throw failure.error;
  }
  assertOwned();
}

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
    if (cause instanceof UpdateRecoveryPublicationUnavailableError) {
      throw cause;
    }
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
