import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  assertNoUnresolvedUpdateRecoveryBackup,
  createUpdateRecoveryBackup,
  inspectUpdateRecoveryBackups,
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
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
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

type UpdateBackupParams = { opts: UpdateCommandOptions; root: string; env: NodeJS.ProcessEnv };

export async function reconcileUpdateCommandBackups(params: UpdateBackupParams): Promise<void> {
  const run = params.opts.run;
  const executorFence = run?.executorFence;
  const assertOwned = () => {
    if (params.opts.run !== run || run?.executorFence !== executorFence) {
      throw new Error("Update recovery admission lost its original executor.");
    }
    assertUpdateCommandRecovery(params.opts);
  };
  assertOwned();
  const captures = await withOwnedManagedUpdateEnv(params.env, () =>
    inspectUpdateRecoveryBackups({ installRoot: params.root }),
  );
  assertOwned();
  if (captures.length === 0) {
    return;
  }
  if (!run || !executorFence) {
    throw new Error("Update recovery admission requires its admitted executor.");
  }
  assertCaptureStateOwner(run.env, params.env);
  const { resolveCompletedDoctorUpdateRecovery } =
    await import("../../commands/doctor-update-recovery.js");
  try {
    await withOwnedManagedUpdateEnv(params.env, () =>
      resolveCompletedDoctorUpdateRecovery({
        installRoot: params.root,
        executorFence,
        runtime: params.opts.json
          ? { ...defaultRuntime, log: defaultRuntime.error }
          : defaultRuntime,
      }),
    );
  } catch (cause) {
    assertOwned();
    throw new UpdatePreMutationError(
      "update-recovery-pending",
      `${formatErrorMessage(cause)} Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
      { cause },
    );
  }
  assertOwned();
}

async function assertUpdateBackupWriters(params: UpdateBackupParams): Promise<void> {
  const { readActiveOpenClawAgentDatabaseLeasesReadOnly } =
    await import("../../state/openclaw-agent-db-lease.js");
  const leases = readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: params.env });
  if (leases.length === 0) {
    return;
  }
  const [
    { readActiveGatewayLockIdentity, isSameGatewayLockIdentity },
    { readGatewayServiceState, resolveGatewayService },
    { gatewayServiceCommandUsesRoot },
  ] = await Promise.all([
    import("../../infra/gateway-lock.js"),
    import("../../daemon/service.js"),
    import("./update-command-service-plan.js"),
  ]);
  const gateway = await readActiveGatewayLockIdentity({ env: params.env, requireInspection: true });
  const service = await readGatewayServiceState(resolveGatewayService(), {
    env: params.env,
    requireEffective: true,
  });
  const runtimePid = service.runtime?.pid;
  const launcherStart = runtimePid === undefined ? null : getFileLockProcessStartTime(runtimePid);
  const ownsRoot =
    gateway &&
    (await gatewayServiceCommandUsesRoot({ root: params.root, command: service.command }));
  let ownsGateway = ownsRoot === true && runtimePid === gateway?.pid;
  if (gateway && ownsRoot && runtimePid !== undefined && !ownsGateway && launcherStart !== null) {
    const { readProcessParentPidSync } = await import("../../infra/restart-stale-pids.js");
    const parentPid = readProcessParentPidSync(gateway.pid);
    const currentGateway = await readActiveGatewayLockIdentity({
      env: params.env,
      requireInspection: true,
    });
    // Native managers can track the CLI launcher while its child owns the listener and stores.
    ownsGateway =
      getFileLockProcessStartTime(runtimePid) === launcherStart &&
      currentGateway !== undefined &&
      isSameGatewayLockIdentity(gateway, currentGateway) &&
      currentGateway.pid === gateway.pid &&
      currentGateway.startTime === gateway.startTime &&
      parentPid === runtimePid;
  }
  const unknown = leases.find(
    (lease) =>
      !gateway ||
      !ownsGateway ||
      lease.owner_pid !== gateway.pid ||
      lease.owner_start_time === null ||
      lease.owner_start_time !== gateway.startTime,
  );
  if (unknown) {
    throw new Error(
      `Agent ${unknown.agent_id} database has an independent or unverified writer in process ${unknown.owner_pid}. Update refused before Gateway shutdown. Stop that writer, then inspect openclaw update status --json and retry; npx openclaw@latest doctor --fix provides explicit recovery.`,
    );
  }
}

export async function assertUpdateCommandBackupRecovery(params: UpdateBackupParams): Promise<void> {
  assertUpdateCommandRecovery(params.opts);
  try {
    if (params.opts.run && !params.opts.run.executorFence) {
      const captures = await withOwnedManagedUpdateEnv(params.env, () =>
        inspectUpdateRecoveryBackups(),
      );
      // Git acquires its executor after target inspection. Only terminal
      // candidates can wait for that owner's stricter retirement proof.
      if (
        captures.length > 0 &&
        captures.every(
          (capture) =>
            capture.terminalOutcome === "committed" &&
            capture.captureStatus !== "restored" &&
            capture.captureStatus !== "restore-failed",
        )
      ) {
        return;
      }
      await withOwnedManagedUpdateEnv(params.env, () => assertNoUnresolvedUpdateRecoveryBackup());
    }
    await reconcileUpdateCommandBackups(params);
    await withOwnedManagedUpdateEnv(params.env, () => assertNoUnresolvedUpdateRecoveryBackup());
  } catch (cause) {
    throw new UpdatePreMutationError("update-recovery-pending", formatErrorMessage(cause));
  }
  assertUpdateCommandRecovery(params.opts);
}

export async function preflightUpdateCommandBackup(params: UpdateBackupParams): Promise<void> {
  try {
    await reconcileUpdateCommandBackups(params);
    await withOwnedManagedUpdateEnv(params.env, async () => {
      await assertNoUnresolvedUpdateRecoveryBackup();
      await assertUpdateBackupWriters(params);
      const run = params.opts.run;
      if (!run) {
        throw new Error("Update recovery admission lost its run.");
      }
      const executorFence = run.executorFence;
      const { preflightUpdateRecoveryBackup } =
        await import("../../infra/update-recovery-backup-create.js");
      await preflightUpdateRecoveryBackup({
        runId: run.runId,
        installRoot: params.root,
        assertOwned() {
          if (params.opts.run !== run || run.executorFence !== executorFence) {
            throw new Error("Update recovery admission lost its original executor.");
          }
          assertUpdateCommandRecovery(params.opts);
        },
      });
    });
    assertUpdateCommandRecovery(params.opts);
  } catch (cause) {
    assertUpdateCommandRecovery(params.opts);
    if (cause instanceof UpdatePreMutationError) {
      throw cause;
    }
    throw new UpdatePreMutationError("update-capture-failed", formatErrorMessage(cause), { cause });
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
  const recovery = params.opts.recovery;
  const assertOwned = () => {
    if (
      params.opts.run !== run ||
      run.executorFence !== executor ||
      params.opts.recovery !== recovery
    ) {
      throw new Error("Update recovery backup lost its original executor or recovery context.");
    }
    executor?.assertCurrent();
  };
  await reconcileUpdateCommandBackups(params);
  assertOwned();
  const backup = await withOwnedManagedUpdateEnv(params.env, async () => {
    const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
    assertOwned();
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: defaultRuntime,
    });
    if (!maintenance) {
      throw new Error("Update recovery capture requires offline state maintenance.");
    }
    let outcome: { ok: true; value: UpdateRecoveryBackupRef } | { ok: false; error: unknown };
    try {
      assertOwned();
      maintenance.assertCurrent();
      assertUpdateCommandRecovery(params.opts);
      outcome = {
        ok: true,
        value: await createUpdateRecoveryBackup({
          runId: run.runId,
          installRoot: params.root,
          assertOwned() {
            assertOwned();
            maintenance.assertCurrent();
          },
        }),
      };
      assertOwned();
      maintenance.assertCurrent();
      assertUpdateCommandRecovery(params.opts);
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // Fresh Doctor children acquire these physical owners themselves.
      await maintenance.release();
    } catch (error) {
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, error],
          "Update capture and physical maintenance settlement failed.",
          { cause: error },
        );
      }
      throw error;
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  });
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
