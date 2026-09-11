import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  createUpdateRecoveryBackup,
  retireUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../../infra/update-recovery-backup.js";
import {
  getUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  assertNoPendingUpdateRecovery,
  type UpdateRecoveryFence,
} from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";
import { deferUpdateCommandCaptureRetirement } from "./update-command-terminal.js";

function assertCaptureStateOwner(runEnv: NodeJS.ProcessEnv, captureEnv: NodeJS.ProcessEnv): void {
  if (
    resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(runEnv)) !==
    resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(captureEnv))
  ) {
    throw new Error(
      "Update capture state differs from its admitted run; inspect with openclaw update status --json before retrying.",
    );
  }
}

export async function createUpdateCommandBackup(params: {
  opts: UpdateCommandOptions;
  root: string;
  env: NodeJS.ProcessEnv;
}): Promise<UpdateRecoveryBackupRef> {
  const run = params.opts.run;
  if (!run) {
    throw new Error("Update recovery backup requires its admitted run.");
  }
  assertCaptureStateOwner(run.env, params.env);
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
  params: Pick<
    FinishUpdateParams,
    "updateRecoveryBackup" | "root" | "opts" | "ownedManagedUpdateEnv"
  >,
  result: UpdateRunResult,
  assertCurrent: () => void,
  retireInTarget?: (result: UpdateRunResult) => Promise<string | undefined>,
): Promise<void> {
  const backup = params.updateRecoveryBackup;
  const run = params.opts.run;
  if (!backup || !run || result.status !== "ok") {
    return;
  }
  assertCurrent();
  const env = { ...(params.ownedManagedUpdateEnv ?? run.env) };
  const warn = (finalResult: UpdateRunResult, detail: string) => {
    defaultRuntime.error(`Warning: ${detail}`);
    finalResult.steps.push({
      name: "backup completion warning",
      command: "openclaw update",
      cwd: params.root,
      durationMs: 0,
      exitCode: 0,
      stderrTail: detail,
    });
  };
  const retain = (finalResult: UpdateRunResult, error: unknown) => {
    const detail = `Update recovery capture requires inspection at ${backup.manifestPath}: ${formatErrorMessage(error)}. Inspect with \`openclaw update status --json\`; resolve with \`npx openclaw@latest doctor --fix\`.`;
    warn(finalResult, detail);
    try {
      recordUpdateRunDiagnostic(run.runId, detail, { env: run.env });
    } catch {
      // The retained capture and stderr remain inspectable when history is unavailable.
    }
  };
  const deferred = deferUpdateCommandCaptureRetirement(run, result, async (finalResult) => {
    if (finalResult.status !== "ok") {
      return;
    }
    let retired = false;
    try {
      const warning = retireInTarget
        ? await retireInTarget(finalResult)
        : await retireVerifiedUpdateCommandCapture(
            { backup, run, root: params.root, env },
            finalResult,
          );
      retired = true;
      if (warning) {
        warn(finalResult, `Update recovery capture retired at ${backup.manifestPath}; ${warning}`);
      }
    } catch (error) {
      if (retired) {
        warn(
          finalResult,
          `Update recovery capture retired at ${backup.manifestPath}, but cleanup reporting failed: ${formatErrorMessage(error)}`,
        );
      } else {
        retain(finalResult, error);
      }
    }
  });
  if (!deferred) {
    retain(
      result,
      new Error("The enclosing update executor has not established terminal settlement"),
    );
  }
}

/** The current runtime verifies durable success under a newly acquired executor. */
export async function retireVerifiedUpdateCommandCapture(
  params: {
    backup: UpdateRecoveryBackupRef;
    run: NonNullable<UpdateCommandOptions["run"]>;
    root: string;
    env: NodeJS.ProcessEnv;
    executorFence?: UpdateRecoveryFence;
  },
  finalResult: UpdateRunResult,
): Promise<string | undefined> {
  const { backup, run, env } = params;
  assertCaptureStateOwner(run.env, env);
  let retired = false;
  const retire = async (fence: UpdateRecoveryFence) => {
    fence.assertCurrent();
    await assertUpdateRecoveryAdmission({ env });
    const manifest = await verifyUpdateRecoveryBackup(backup);
    const assertOwned = () => {
      fence.assertCurrent();
      assertNoPendingUpdateRecovery({ env });
      const saved = getUpdateRun(run.runId, { env: run.env });
      const health = saved?.verification;
      if (
        finalResult.status !== "ok" ||
        manifest.runId !== run.runId ||
        manifest.installRoot !== path.resolve(params.root) ||
        finalResult.runId !== run.runId ||
        saved?.status !== "succeeded" ||
        !saved.finishedAtMs ||
        !saved.confirmedAtMs ||
        !saved.after.version ||
        saved.after.version !== finalResult.after?.version ||
        health?.runningVersion !== saved.after.version ||
        (saved.after.buildId && health.runningBuildId !== saved.after.buildId) ||
        health.serviceRunning !== true ||
        health.versionMatch !== true ||
        health.readyz !== true ||
        health.settled !== true ||
        health.channelsReady !== true ||
        health.pluginErrors?.length !== 0 ||
        !saved.steps.some(
          (step) => step.step === "gateway verification" && step.status === "completed",
        )
      ) {
        throw new Error("The update has no matching durable, verified terminal success");
      }
    };
    assertOwned();
    await writeUpdateRecoveryBackupOutcome(backup, { status: "committed" }, { assertOwned });
    await retireUpdateRecoveryBackup(backup, { assertOwned });
    retired = true;
    recordUpdateRunDiagnostic(
      run.runId,
      `Update recovery capture retired: ${backup.manifestPath}`,
      { env: run.env },
    );
  };
  try {
    await withOwnedManagedUpdateEnv(env, () =>
      params.executorFence
        ? retire(params.executorFence)
        : withUpdateCommandExecutor(run.runId, async (executor) =>
            retire(await executor.enter(finalResult.root ?? params.root)),
          ),
    );
  } catch (error) {
    if (!retired) {
      throw error;
    }
    return `cleanup reporting or executor settlement failed: ${formatErrorMessage(error)}`;
  }
  return undefined;
}

export async function retainUpdatePackageBackup(
  transaction: PackageUpdateTransaction,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<void> {
  const retained = await transaction.complete({ activationVerified: false }, assertCurrent);
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
