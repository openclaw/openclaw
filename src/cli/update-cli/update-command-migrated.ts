import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { finishUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { CLI_NAME } from "../cli-name.js";
import { printResult } from "./progress.js";
import { readPackageVersion, resolveNodeRunner } from "./shared.js";
import { completeUpdateCommandBackup } from "./update-command-backup-lifecycle.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
  UpdateCaptureRetirementInput,
} from "./update-command-migrated-types.js";
import {
  createUpdateCommandFinalizationFence,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import {
  recordUpdateResultNextAction,
  resolveCompletedUpdateResult,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import { recordVerifiedUpdatePackageCleanup } from "./update-command-terminal.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

export type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "./update-command-migrated-types.js";

/** Inspect private state copies without reopening migrated state through the previous runtime. */
export async function inspectActivatedUpdateState(
  params: Pick<
    FinishUpdateParams,
    "result" | "root" | "schemaVersions" | "packageUpdateNodeRunner"
  > & {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    candidateSchemaVersions?: OpenClawSchemaVersions;
  },
): Promise<FinishUpdateParams["rollbackBlockedReason"]> {
  const { result, root, schemaVersions, candidateSchemaVersions, env, config } = params;
  if (!schemaVersions) {
    return undefined;
  }
  try {
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
      nodeRunner: params.packageUpdateNodeRunner,
    });
    const shared = current.find((entry) => entry.path === resolveOpenClawStateSqlitePath(env));
    const sharedVersion = shared ? resolveUpdateStateContentVersion(shared) : undefined;
    if (
      result.status === "ok" &&
      candidateSchemaVersions &&
      sharedVersion !== candidateSchemaVersions.state
    ) {
      // Doctor can warn without failing. Require applied content so startup
      // cannot migrate late; deferred publication alone is already ready.
      result.status = "error";
      result.reason = `${CLI_NAME} doctor`;
      result.steps.push({
        name: `${CLI_NAME} doctor`,
        command: `${CLI_NAME} doctor --fix`,
        cwd: result.root ?? root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `Shared state migration did not finish: expected schema ${candidateSchemaVersions.state}, found ${sharedVersion ?? "missing"}.`,
      });
    }
    return updateStateSchemaVersionsMatch(schemaVersions, current, {
      sharedPath: resolveOpenClawStateSqlitePath(env),
      candidateSchemaVersions,
    })
      ? undefined
      : "state-migrated-no-rollback";
  } catch (error) {
    result.status = "error";
    result.reason = "rollback-state-unverified";
    result.steps.push({
      name: "state schema verification",
      command: "openclaw update",
      cwd: result.root ?? root,
      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    });
    return "rollback-state-unverified";
  }
}

type MigratedUpdateOutcome = Pick<
  MigratedUpdateFinalizationResult,
  "result" | "exitCode" | "automaticTriage"
>;

async function recoverMigratedUpdateInParent(
  params: FinishUpdateParams,
  result: FinishUpdateParams["result"],
  bufferedSteps: UpdateRunStep[],
  windowsHandedOff: boolean,
  assertCurrent: () => void,
): Promise<MigratedUpdateOutcome> {
  const run = params.opts.run;
  assertCurrent();
  const before = params.preManagedServiceStop;
  // The guardian stays delegated. A new owner can enable the restored task only
  // after the candidate is gone and the original executor has resumed.
  const adoptedWindowsRecovery =
    windowsHandedOff && before?.serviceEnv
      ? createWindowsTaskAutoStartRecovery({
          serviceEnv: before.serviceEnv,
          alreadySuspended: true,
          updateRun: run,
          assertCurrent,
          assertCurrentService: createWindowsTaskAutoStartGuard({
            root: params.root,
            before,
            timeoutMs: params.updateStepTimeoutMs,
          }),
        })
      : undefined;
  let rollback: Awaited<ReturnType<typeof rollbackFailedUpdate>> | undefined;
  try {
    rollback = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () => {
      assertCurrent();
      return rollbackFailedUpdate({
        result,
        previousRoot: params.root,
        packageTransaction: params.packageTransaction,
        updateRecoveryBackup: params.updateRecoveryBackup,
        rollbackBlockedReason: params.rollbackBlockedReason,
        schemaVersions: params.schemaVersions,
        candidateSchemaVersions: params.candidateSchemaVersions,
        previousSchemaVersions: params.previousSchemaVersions,
        previousVerified: params.previousVerified,
        configSnapshot: params.configSnapshot,
        activationConfig: params.activationConfig,
        opts: params.opts,
        preManagedServiceStop:
          adoptedWindowsRecovery && before
            ? { ...before, windowsTaskAutoStartRecovery: adoptedWindowsRecovery }
            : before,
        timeoutMs: params.updateStepTimeoutMs,
        nodeRunner: params.packageUpdateNodeRunner,
        invocationCwd: params.invocationCwd,
      });
    });
  } finally {
    try {
      await adoptedWindowsRecovery?.complete(rollback?.rolledBack === true);
    } finally {
      // The adopted owner handles compensation without consulting the migrated
      // ledger through the guardian's previous-runtime authority callback.
      await before?.windowsTaskAutoStartRecovery?.complete(
        adoptedWindowsRecovery !== undefined || rollback?.rolledBack === true,
      );
    }
  }
  assertCurrent();
  if (!rollback.stateRestored || rollback.pendingRecoveryReason) {
    // The previous reader cannot inspect or write a forward-migrated ledger.
    throw new UpdateCommandPendingRecoveryFailure(
      rollback.result,
      rollback.pendingRecoveryReason ??
        `Update recovery could not restore ${params.updateRecoveryBackup?.directory ?? "the missing backup"}. Run \`npx openclaw@latest doctor --fix\` to recover.`,
    );
  }
  const finalResult = resolveCompletedUpdateResult(params, {
    ...rollback.result,
    runId: run?.runId,
  });
  if (run) {
    for (const step of bufferedSteps) {
      assertCurrent();
      recordUpdateRunStep(run.runId, step, { env: run.env });
    }
  }
  const nextAction = recordUpdateResultNextAction(params, finalResult);
  const stoppedAtMs =
    params.preManagedServiceStop?.stoppedAtMs ?? rollback.stoppedForRollback?.stoppedAtMs;
  const downtimeMs =
    stoppedAtMs !== undefined && rollback.verifiedAtMs !== undefined
      ? Math.max(0, rollback.verifiedAtMs - stoppedAtMs)
      : undefined;
  assertCurrent();
  if (run && rollback.rolledBack) {
    finishUpdateRun(
      run.runId,
      { status: "rolled-back", reason: finalResult.reason, after: finalResult.after, downtimeMs },
      { env: run.env },
    );
  }
  const completed = completeUpdateCommandRun(finalResult, run, downtimeMs);
  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: params.controlPlaneUpdateSentinelMeta,
    result: completed,
    jsonMode: Boolean(params.opts.json),
  });
  assertCurrent();
  printResult(completed, params.opts, { nextAction });
  const retained = await params.packageTransaction
    ?.complete({ activationVerified: false }, assertCurrent)
    .catch((error: unknown) => {
      assertCurrent();
      defaultRuntime.error(`Update backup cleanup failed: ${formatErrorMessage(error)}`);
    });
  if (retained) {
    completed.steps.push(retained);
    if (retained.stderrTail) {
      defaultRuntime.error(retained.stderrTail);
    }
  }
  return { result: completed, exitCode: 1 };
}

/** Candidate code owns migrated state until verified restoration returns it to the parent. */
export async function continueMigratedUpdateInFreshProcess(
  params: FinishUpdateParams,
  bufferedSteps: UpdateRunStep[],
): Promise<MigratedUpdateOutcome> {
  if (params.opts.recovery) {
    throw new UpdateCommandRecoveryPendingError("Full-state checkpoint recovery is deferred.");
  }
  const run = params.opts.run;
  if (!run) {
    throw new Error("Migrated update continuation requires its admitted run.");
  }
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  assertCurrent();
  const windowsRecovery = params.preManagedServiceStop?.windowsTaskAutoStartRecovery;
  const result = params.result;
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-migrated-"));
  let candidateExtinguished = false;
  let recoveryAttempted = false;
  let windowsHandedOff = false;
  let parentRecoverySupported = false;
  let captureRetirementSupported = false;
  const recover = async (failure: FinishUpdateParams["result"]) => {
    recoveryAttempted = true;
    assertCurrent();
    return await recoverMigratedUpdateInParent(
      params,
      failure,
      bufferedSteps,
      windowsHandedOff,
      assertCurrent,
    );
  };
  try {
    assertCurrent();
    const root = result.root;
    if (!root) {
      throw new Error("The active installation root is unknown; candidate finalization is unsafe.");
    }
    const workerCommand = [
      params.packageUpdateNodeRunner ?? resolveNodeRunner(),
      path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
    ];
    const workerEnv = {
      ...stripGatewayServiceMarkerEnv(
        resolveUpdatedInstallCommandEnv({
          processEnv: params.ownedManagedUpdateEnv ?? run.env,
        }),
      ),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir,
    };
    if (run.executorFence || params.updateRecoveryBackup) {
      assertCurrent();
      // Compatibility only, never authority. An older installed worker ignores
      // new JSON fields, so refuse before exposing any continuation input.
      const check = await runUtf8CommandWithTimeout([...workerCommand, "--check"], {
        cwd: root,
        baseEnv: {},
        env: workerEnv,
        timeoutMs: 30_000,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        killGraceMs: 500,
        maxOutputBytes: 64 * 1024,
      });
      candidateExtinguished = check.cleanup !== "uncertain";
      assertCurrent();
      let contract: unknown;
      try {
        contract = JSON.parse(check.stdout);
      } catch (cause) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate live executor delegation capability could not be inspected.",
          { cause },
        );
      }
      if (
        check.termination !== "exit" ||
        check.code !== 0 ||
        check.cleanup !== "normal" ||
        !isRecord(contract) ||
        contract.executorDelegation !== "pid-start-v1"
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate runtime does not support the required live executor delegation.",
        );
      }
      parentRecoverySupported = contract.updateRecovery === "parent-v1";
      captureRetirementSupported = contract.captureRetirement === "settled-v1";
    }
    if (windowsRecovery && params.preManagedServiceStop) {
      // The parent retains its original definition-refresh grant for compensation.
      // Only the fresh finalizer may restore autostart at activation after migration.
      windowsRecovery.handoff(
        createWindowsTaskAutoStartGuard({
          root: result.root ?? params.root,
          before: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
        }),
      );
      windowsHandedOff = true;
    }
    const {
      packageTransaction: _transaction,
      updateRecoveryBackup: _backup,
      candidateUpdateRecovery: _capability,
      deferFailureRecoveryToParent: _defer,
      preManagedServiceStop,
      ...serializable
    } = params;
    let stopState: MigratedUpdateFinalizationInput["params"]["preManagedServiceStop"];
    if (preManagedServiceStop) {
      const { windowsTaskAutoStartRecovery: _windows, ...serializableStop } = preManagedServiceStop;
      stopState = serializableStop;
    }
    const resultPath = path.join(scratchDir, "result.json");
    const { requesterAuthority, executorFence, ...runIdentity } = run;
    const input: MigratedUpdateFinalizationInput = {
      params: {
        ...serializable,
        opts: {
          ...params.opts,
          run: {
            ...runIdentity,
            ...(requesterAuthority
              ? { requesterAuthority: { requester: requesterAuthority.requester } }
              : {}),
          },
        },
        rollbackBlockedReason: params.rollbackBlockedReason ?? "state-migrated-no-rollback",
        ...(parentRecoverySupported && params.candidateUpdateRecovery
          ? { candidateUpdateRecovery: params.candidateUpdateRecovery }
          : {}),
        ...(parentRecoverySupported && params.updateRecoveryBackup
          ? {
              updateRecoveryBackup: params.updateRecoveryBackup,
              deferFailureRecoveryToParent: true,
            }
          : {}),
        ...(preManagedServiceStop ? { preManagedServiceStop: stopState } : {}),
      },
      bufferedSteps,
      ...(windowsRecovery ? { windowsTaskAutoStartSuspended: true } : {}),
      resultPath,
    };
    const runChild = async (
      grant?: UpdateCommandChildGrant,
      beforeInput?: (pid: number) => void,
    ) => {
      try {
        const command = await runUtf8CommandWithTimeout(workerCommand, {
          cwd: root,
          baseEnv: {},
          env: workerEnv,
          input: JSON.stringify({ ...input, ...(grant ? { executor: grant } : {}) }),
          beforeInput,
          // This continuation includes bounded plugin steps as well as service
          // verification; the whole-process bound must exceed one step's budget.
          timeoutMs: Math.max(30 * 60_000, params.updateStepTimeoutMs * 6),
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          killGraceMs: 500,
          maxOutputBytes: 1024 * 1024,
        });
        return { command };
      } catch (error) {
        if (
          params.updateRecoveryBackup &&
          isRecord(error) &&
          (error.cleanup === "normal" ||
            error.cleanup === "cooperative" ||
            error.cleanup === "forced")
        ) {
          // A settled transport failure returns custody normally; rejecting the
          // delegated operation would retain an unresolved executor failure.
          return { error };
        }
        throw error;
      }
    };
    candidateExtinguished = false;
    const outcome = executorFence
      ? await withUpdateCommandExecutorChild(executorFence, root, runChild)
      : await runChild();
    if ("error" in outcome) {
      candidateExtinguished = true;
      assertCurrent();
      throw toErrorObject(outcome.error, "Candidate finalization transport failed");
    }
    const child = outcome.command;
    candidateExtinguished = child.cleanup !== "uncertain";
    assertCurrent();
    if (child.stdout) {
      process.stdout.write(child.stdout);
    }
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    const response = JSON.parse(
      await fs.readFile(resultPath, "utf8"),
    ) as MigratedUpdateFinalizationResult; // SAFETY: Only the candidate worker launched above writes this private artifact.
    assertCurrent();
    if (
      child.termination !== "exit" ||
      child.code !== 0 ||
      child.cleanup !== "normal" ||
      (executorFence && response.executorDelegation !== "pid-start-v1") ||
      (response.recoveryRequired
        ? !parentRecoverySupported ||
          !params.updateRecoveryBackup ||
          response.result.status !== "error"
        : response.terminalRunId !== run.runId) ||
      response.result.runId !== run.runId ||
      !Number.isInteger(response.exitCode)
    ) {
      throw new Error(
        "Candidate finalization did not confirm the admitted run's terminal outcome.",
      );
    }
    if (params.updateRecoveryBackup && response.result.status === "error") {
      return await recover(response.result);
    }
    try {
      await windowsRecovery?.complete(response.result.status === "ok");
    } catch (cause) {
      throw new UpdateCommandFailure(
        response.result,
        response.exitCode || 1,
        `${response.result.reason ?? "Update failed"}; Windows task autostart compensation failed: ${formatErrorMessage(cause)}`,
        { cause },
      );
    }
    if (params.updateRecoveryBackup && response.result.status === "ok") {
      const backup = params.updateRecoveryBackup;
      const runtimeRoot = await fs.realpath(root);
      const runtimeBuildId = await readBuiltGatewayBuildId(root);
      const retirementEnv = {
        ...workerEnv,
        TMPDIR: os.tmpdir(),
        TMP: os.tmpdir(),
        TEMP: os.tmpdir(),
      };
      await completeUpdateCommandBackup(
        params,
        response.result,
        assertCurrent,
        async (settledResult) => {
          if (
            !captureRetirementSupported ||
            !runtimeBuildId ||
            (await fs.realpath(root)) !== runtimeRoot ||
            (await readPackageVersion(root)) !== settledResult.after?.version ||
            (await readBuiltGatewayBuildId(root)) !== runtimeBuildId
          ) {
            throw new Error(
              "Verified candidate capture-retirement runtime is unavailable or changed.",
            );
          }
          const retirementInput: UpdateCaptureRetirementInput = {
            runId: run.runId,
            root: params.root,
            runtimeRoot,
            runtimeBuildId,
            backup,
            result: settledResult,
          };
          const retirementChild = await withUpdateCommandExecutor(run.runId, async (executor) => {
            const fence = await executor.enter(root);
            return await withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
              runUtf8CommandWithTimeout([...workerCommand, "--retire-capture"], {
                cwd: root,
                baseEnv: {},
                env: retirementEnv,
                input: JSON.stringify({ ...retirementInput, executor: grant }),
                beforeInput,
                timeoutMs: params.updateStepTimeoutMs,
                killProcessTree: true,
                requireProcessTreeExtinction: true,
                killGraceMs: 500,
                maxOutputBytes: 64 * 1024,
              }),
            );
          });
          const receipt: unknown = JSON.parse(retirementChild.stdout);
          if (
            retirementChild.termination !== "exit" ||
            retirementChild.code !== 0 ||
            retirementChild.cleanup !== "normal" ||
            !isRecord(receipt) ||
            receipt.retired !== true ||
            receipt.runId !== run.runId ||
            receipt.manifestSha256 !== backup.manifestSha256 ||
            (receipt.warning !== undefined && typeof receipt.warning !== "string")
          ) {
            throw new Error(
              `Capture retirement was not confirmed by the candidate: ${retirementChild.stderr}`,
            );
          }
          return receipt.warning;
        },
      );
    }
    const cleanupFailure = await recordVerifiedUpdatePackageCleanup(
      params,
      response.result,
      assertCurrent,
    );
    if (cleanupFailure) {
      return { result: cleanupFailure.result, exitCode: cleanupFailure.exitCode };
    }
    return {
      result: response.result,
      exitCode: response.exitCode,
      automaticTriage: response.automaticTriage,
    };
  } catch (error) {
    if (recoveryAttempted) {
      throw error;
    }
    if (params.updateRecoveryBackup && candidateExtinguished) {
      assertCurrent();
      return await recover({
        ...result,
        status: "error",
        reason: "candidate-finalization-failed",
        steps: [
          ...result.steps,
          {
            name: "candidate finalization",
            command: "openclaw update",
            cwd: result.root ?? params.root,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(error),
          },
        ],
      });
    }
    if (error instanceof UpdateCommandRecoveryPendingError) {
      // A refused compatibility/admission check is not delegated completion and
      // cannot authorize native restoration in the old, migrated runtime.
      throw error;
    }
    try {
      await windowsRecovery?.complete(false);
    } catch (cause) {
      throw new AggregateError(
        [error, cause],
        `Candidate finalization failed (${formatErrorMessage(error)}) and Windows task autostart compensation failed (${formatErrorMessage(cause)})`,
        { cause },
      );
    }
    throw error;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}
