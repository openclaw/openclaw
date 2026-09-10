import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  createUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../../infra/update-recovery-backup.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";

export async function createUpdateCommandBackup(params: {
  opts: UpdateCommandOptions;
  root: string;
  env: NodeJS.ProcessEnv;
}): Promise<UpdateRecoveryBackupRef> {
  const run = params.opts.run;
  if (!run) {
    throw new Error("Update recovery backup requires its admitted run.");
  }
  const executor = run.executorFence;
  const assertOwned = () => {
    if (params.opts.run !== run || run.executorFence !== executor) {
      throw new Error("Update recovery backup lost its original executor.");
    }
    assertUpdateCommandRecovery(params.opts);
  };
  const backup = await withOwnedManagedUpdateEnv(params.env, () =>
    createUpdateRecoveryBackup({ runId: run.runId, installRoot: params.root, assertOwned }),
  );
  assertOwned();
  recordUpdateRunStep(
    run.runId,
    {
      step: "update recovery backup",
      status: "completed",
      endedAtMs: Date.now(),
      detail: backup.manifestPath,
    },
    { env: run.env },
  );
  return backup;
}

export async function completeUpdateCommandBackup(
  params: Pick<FinishUpdateParams, "updateRecoveryBackup" | "root">,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<void> {
  if (!params.updateRecoveryBackup || result.status === "error") {
    return;
  }
  try {
    await writeUpdateRecoveryBackupOutcome(
      params.updateRecoveryBackup,
      { status: "committed" },
      { assertOwned: assertCurrent },
    );
  } catch (error) {
    assertCurrent();
    const detail = `Update recovery backup retained at ${params.updateRecoveryBackup.manifestPath}; completion metadata could not be written: ${formatErrorMessage(error)}`;
    defaultRuntime.error(`Warning: ${detail}`);
    result.steps.push({
      name: "backup completion warning",
      command: "openclaw update",
      cwd: params.root,
      durationMs: 0,
      exitCode: 0,
      stderrTail: detail,
    });
  }
}

export async function retainUpdatePackageBackup(
  transaction: PackageUpdateTransaction,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<void> {
  const retained = await transaction.complete({ activationVerified: false });
  assertCurrent();
  if (retained) {
    const backupPath = transaction.backupRoot;
    result.steps = [
      ...result.steps,
      {
        ...retained,
        stderrTail:
          retained.exitCode === 0 || retained.stderrTail?.includes(backupPath)
            ? retained.stderrTail
            : [retained.stderrTail, `Recovery transaction backup path: ${backupPath}`]
                .filter(Boolean)
                .join("\n"),
      },
    ];
  }
}
