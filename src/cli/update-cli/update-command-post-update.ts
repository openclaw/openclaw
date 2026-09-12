import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  resolveManagedServiceUpdateFailureExitCode,
} from "../../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import {
  assertUpdateCommandPackageFinalization,
  createUpdateCommandFinalizationFence,
} from "./update-command-recovery.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  UpdateCommandFailure,
  resolveAutomaticUpdateTriage,
  recordUpdateResultNextAction,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { UpdateServiceLoadBoundaryError } from "./update-command-service-load.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import {
  recordFailedUpdateGatewayState,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  tryInstallShellCompletion,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import {
  deferUpdateCommandTerminalResult,
  recordVerifiedUpdatePackageCleanup,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";

export type { FinishUpdateParams } from "./update-command-finish-types.js";

export async function finishUpdate(params: FinishUpdateParams): Promise<UpdateRunResult> {
  if (params.serviceLoadBoundary && process.platform !== "linux") {
    throw new Error("Deferred native service loading is not supported on this platform.");
  }
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  assertCurrent();
  await assertUpdateCommandPackageFinalization(params);
  assertCurrent();
  const shouldRestart =
    params.shouldRestart &&
    (!params.coreAlreadyCurrent || params.preManagedServiceStop?.running === true);
  let gateway: TriageFailureContext["gateway"] = "preserve";
  let triageAllowed = true;
  const createFailure = (
    result: UpdateRunResult,
    exitCode = 1,
    detail?: string,
    options?: ErrorOptions,
  ) =>
    new UpdateCommandFailure(result, exitCode, detail, {
      ...options,
      automaticTriage: triageAllowed
        ? resolveAutomaticUpdateTriage(result, detail, { ...params, gateway })
        : undefined,
    });
  let rollbackAttempted = false;
  let postVerificationRepairAttempted = false;
  let rollbackStopState: PreManagedServiceStop | undefined;
  // Rollback can replace the suspension owner.
  const currentServiceStop = () => rollbackStopState ?? params.preManagedServiceStop;
  const resumeWindowsAutoStart = async (result: UpdateRunResult) => {
    const stopped = currentServiceStop();
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
      stopped,
      true,
      stopped
        ? createWindowsTaskAutoStartGuard({
            root: result.root ?? params.root,
            before: stopped,
            timeoutMs: params.updateStepTimeoutMs,
          })
        : undefined,
    );
  };
  let rolledBack = false;
  let completedDowntimeMs: number | undefined = params.coreAlreadyCurrent ? 0 : undefined;
  let pendingRestartAtMs =
    params.preManagedServiceStop?.stoppedAtMs ??
    params.controlPlaneUpdateSentinelMeta?.serviceStoppedAtMs;
  // Health resets replace ledger verification. Keep completed outages here
  // until final reporting, including a separately verified rollback.
  const recordVerifiedDowntime = (verifiedAtMs: number) => {
    if (pendingRestartAtMs !== undefined) {
      completedDowntimeMs =
        (completedDowntimeMs ?? 0) + Math.max(0, verifiedAtMs - pendingRestartAtMs);
      pendingRestartAtMs = undefined;
    }
  };
  // Finalization owns the complete outcome, including recovery, restart, and completion work.
  const completedResult = (result: UpdateRunResult): UpdateRunResult => ({
    ...result,
    ...(result.status === "error" && params.rollbackBlockedReason
      ? { reason: params.rollbackBlockedReason }
      : {}),
    durationMs: Math.max(0, Date.now() - params.startedAt),
  });
  const recordNextAction = (result: UpdateRunResult) => {
    assertCurrent();
    return recordUpdateResultNextAction(params, result);
  };
  // Restart can let the new Gateway finish the row before CLI finalization resumes.
  // Store the next action before that handoff, and refresh it if recovery changes the outcome.
  recordNextAction(params.result);

  let pendingResult = params.result;
  let pendingNotify = true;
  const publishFinalResult = async (failure?: unknown): Promise<UpdateRunResult> => {
    const settled = await resolveSettledUpdateCommandResult(params, pendingResult, failure);
    const result = completedResult(settled.result);
    result.recovery = settled.settlementFailed ? undefined : result.recovery;
    const reportDowntime = !settled.settlementFailed && pendingRestartAtMs === undefined;
    if (pendingNotify) {
      const meta = params.controlPlaneUpdateSentinelMeta;
      const jsonMode = Boolean(params.opts.json);
      await writeControlPlaneUpdateRestartSentinelBestEffort({ meta, result, jsonMode });
    }
    return publishUpdateCommandTerminalResult(params, result, {
      rolledBack: rolledBack && !settled.settlementFailed,
      downtimeMs: reportDowntime ? completedDowntimeMs : undefined,
    });
  };
  const deferredTerminal = deferUpdateCommandTerminalResult(params.opts.run, publishFinalResult);
  const recoverFailedResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService: boolean,
    repair?: (result: UpdateRunResult) => Promise<UpdateRunResult>,
  ) => {
    assertCurrent();
    let result = initialResult;
    let recoverService = initialRecoverService;
    if (
      result.status === "error" &&
      (params.packageTransaction || params.rollbackBlockedReason) &&
      !rollbackAttempted
    ) {
      rollbackAttempted = true;
      const rollback = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () =>
        rollbackFailedUpdate({
          result,
          previousRoot: params.root,
          packageTransaction: params.packageTransaction,
          rollbackBlockedReason: params.rollbackBlockedReason,
          schemaVersions: params.schemaVersions,
          candidateSchemaVersions: params.candidateSchemaVersions,
          previousSchemaVersions: params.previousSchemaVersions,
          previousVerified: params.previousVerified,
          configSnapshot: params.configSnapshot,
          activationConfig: params.activationConfig,
          opts: params.opts,
          preManagedServiceStop: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          invocationCwd: params.invocationCwd,
        }),
      );
      result = rollback.result;
      rollbackStopState = rollback.stoppedForRollback;
      rolledBack = rollback.rolledBack;
      pendingRestartAtMs ??= rollbackStopState?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (
      result.status === "error" &&
      params.rollbackBlockedReason &&
      !postVerificationRepairAttempted
    ) {
      result = { ...result, reason: params.rollbackBlockedReason };
      recoverService = false;
    } else if (
      result.status === "error" &&
      params.result.status === "ok" &&
      !params.packageTransaction &&
      params.opts.run
    ) {
      recordUpdateRunStep(
        params.opts.run.runId,
        {
          step: "package rollback",
          status: "skipped",
          endedAtMs: Date.now(),
          detail:
            "No retained previous package transaction is available; automatic package restoration was not attempted.",
        },
        { env: params.opts.run.env },
      );
    }
    if (result.status === "error" && !rolledBack && repair) {
      postVerificationRepairAttempted = true;
      const previousRestored = result.recovery?.packageRollbackVerified === true;
      result = await repair(result);
      if (previousRestored && result.status === "ok") {
        // Repair verified the restored release; the requested update still failed.
        rolledBack = true;
        result = { ...result, status: "error", reason: initialResult.reason };
      }
      recoverService = false;
    }
    return { result, recoverService };
  };
  const reportResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService = false,
    initialRestoreFailure?: { cause: unknown },
    notify = true,
  ): Promise<UpdateRunResult> => {
    assertCurrent();
    const { result, recoverService } = await recoverFailedResult(
      initialResult,
      initialRecoverService,
    );
    assertCurrent();
    let restoreFailure = initialRestoreFailure;
    const finalResult = completedResult({
      ...result,
      ...(result.status === "error" && !recoverService && !rolledBack
        ? {
            recovery:
              result.recovery?.serviceRestartSafe === false ||
              result.recovery?.packageRollbackVerified
                ? result.recovery
                : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }
        : {}),
    });
    pendingResult = finalResult;
    pendingNotify = notify;
    if (!restoreFailure) {
      try {
        if (
          !rolledBack &&
          finalResult.status !== "ok" &&
          finalResult.recovery?.serviceRestartSafe !== true
        ) {
          await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
        } else {
          await resumeWindowsAutoStart(finalResult);
        }
      } catch (cause) {
        restoreFailure = { cause };
      }
    }
    if (restoreFailure) {
      rolledBack = false;
      try {
        await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
      } catch (cause) {
        restoreFailure = {
          cause: new AggregateError(
            [restoreFailure.cause, cause],
            `Windows task restoration and compensation failed: ${formatErrorMessage(restoreFailure.cause)}; ${formatErrorMessage(cause)}`,
          ),
        };
      }
      defaultRuntime.error(
        `Failed to restore Windows Scheduled Task autostart: ${String(restoreFailure.cause)}`,
      );
      finalResult.status = "error";
      finalResult.reason =
        result.status === "error" ? result.reason : "windows-task-autostart-restore-failed";
      finalResult.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
      finalResult.steps = [
        ...finalResult.steps,
        {
          name: "Windows task autostart recovery",
          command: "openclaw update",
          cwd: finalResult.root ?? params.root,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(restoreFailure.cause),
        },
      ];
    }
    assertCurrent();
    const retireBackup =
      finalResult.status === "ok" || finalResult.recovery?.packageRollbackVerified === true;
    if (params.packageTransaction && !retireBackup) {
      const retained = await params.packageTransaction.complete(
        { activationVerified: false },
        assertCurrent,
      );
      if (retained) {
        const backupPath = params.packageTransaction.backupRoot;
        finalResult.steps = [
          ...finalResult.steps,
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
    if (finalResult.status === "error" && !rolledBack && currentServiceStop()?.stopped) {
      await recordFailedUpdateGatewayState(
        params.opts.run,
        currentServiceStop()?.serviceEnv ?? process.env,
      );
    }
    recordNextAction(finalResult);
    if (notify && recoverService) {
      pendingNotify = false;
      await writeControlPlaneUpdateRestartSentinelBestEffort({
        meta: params.controlPlaneUpdateSentinelMeta,
        result: finalResult,
        jsonMode: Boolean(params.opts.json),
      });
    }
    // The recovering Gateway reads this notification at startup. Persist once
    // before restarting; rewriting a consumed sentinel could deliver it twice.
    if (recoverService && finalResult.recovery?.serviceRestartSafe === true) {
      const service = await maybeRestartServiceAfterFailedMutableUpdate({
        recovery: result.recovery,
        updateRun: params.opts.run,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      });
      if (service) {
        finalResult.recovery = { ...finalResult.recovery, service };
        if (service === "healthy" && params.shouldRestart) {
          gateway = "verify-running";
        }
        if (service === "failed") {
          finalResult.status = "error";
          try {
            await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
          } catch (cause) {
            return await reportResult(finalResult, false, { cause }, false);
          }
        }
      }
    }
    await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(
      rolledBack ||
        finalResult.status === "ok" ||
        (finalResult.recovery?.serviceRestartSafe === true &&
          finalResult.recovery.service === "healthy"),
    );
    assertCurrent();
    const cleanupFailure = retireBackup
      ? await recordVerifiedUpdatePackageCleanup(params, finalResult, assertCurrent)
      : undefined;
    assertCurrent();
    pendingResult = completedResult(cleanupFailure?.result ?? finalResult);
    const reportedResult = deferredTerminal ? pendingResult : await publishFinalResult();
    if (cleanupFailure) {
      const { detail } = cleanupFailure;
      throw new UpdateCommandFailure(reportedResult, 1, detail, { cause: cleanupFailure });
    }
    if (restoreFailure) {
      // Persist the unsafe outcome before unwinding. Keep both failures for
      // recovery diagnostics, with the failed compensation as the primary cause.
      const priorDetail = [result.reason, params.failure?.detail].filter(Boolean).join(": ");
      const detail =
        `${priorDetail ? `${priorDetail}; ` : ""}Windows Scheduled Task autostart recovery failed: ` +
        formatErrorMessage(restoreFailure.cause);
      const cause = params.failure
        ? new AggregateError([params.failure.cause, restoreFailure.cause], detail, {
            cause: restoreFailure.cause,
          })
        : restoreFailure.cause;
      throw createFailure(
        reportedResult,
        resolveManagedServiceUpdateFailureExitCode(reportedResult),
        detail,
        { cause },
      );
    }
    return reportedResult;
  };
  const restoreWindowsAutoStart = async (result: UpdateRunResult) => {
    try {
      await resumeWindowsAutoStart(result);
    } catch (cause) {
      // The attempted restore already failed; reporting must not attempt it again.
      await reportResult(result, false, { cause });
    }
  };

  try {
    if (params.result.status === "error" || params.result.recovery?.serviceRestartSafe === false) {
      const reported = await reportResult(
        { ...params.result, status: "error" },
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        resolveManagedServiceUpdateFailureExitCode(reported),
        params.failure?.detail,
        params.failure,
      );
    }

    if (params.result.status === "skipped" && !params.coreAlreadyCurrent) {
      const reported = await reportResult(
        params.result,
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        classifyUpdateOutcome(reported) === "failed"
          ? resolveManagedServiceUpdateFailureExitCode(reported)
          : 0,
      );
    }

    const postUpdateRoot = params.result.root ?? params.root;
    const convergePlugins = async (beforeDoctor?: () => Promise<void>) => {
      const pluginParams = { ...params, beforeDoctor, beforePersistentEffect: assertCurrent };
      const convergence = await convergeUpdatePlugins(pluginParams);
      if (convergence.resultWithPostUpdate.status === "error") {
        triageAllowed = !convergence.cancelled;
        const reported = await reportResult(convergence.resultWithPostUpdate);
        throw createFailure(
          reported,
          resolveManagedServiceUpdateFailureExitCode(reported),
          convergence.detail,
        );
      }
      return convergence;
    };
    // A current core may converge plugins online, parking before fresh Doctor.
    // A replaced core keeps convergence in its original stopped interval.
    const deferPluginConvergence =
      shouldRestart &&
      params.coreAlreadyCurrent === true &&
      params.preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned";
    let resultWithPostUpdate = params.result;
    let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
    if (!deferPluginConvergence) {
      ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins());
      if (params.coreAlreadyCurrent) {
        return await reportResult(resultWithPostUpdate);
      }
    }
    const restartConfigSnapshot =
      postUpdateConfigSnapshot ??
      (await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        readConfigFileSnapshot({
          observe: false,
          skipPluginValidation: true,
          suppressFutureVersionWarning: true,
        }),
      ));
    let restartContext: Awaited<ReturnType<typeof prepareUpdateRestart>>;
    try {
      restartContext = await prepareUpdateRestart(
        { ...params, shouldRestart, result: resultWithPostUpdate },
        restartConfigSnapshot,
      );
    } catch (error) {
      const message =
        error instanceof GatewayServiceUpdateOwnershipError
          ? error.message
          : formatErrorMessage(error);
      defaultRuntime.error(message);
      const reported = await reportResult({
        ...resultWithPostUpdate,
        status: "error",
        reason: "service-revalidation-failed",
      });
      throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
        cause: error,
      });
    }
    const notifyRestart = () =>
      writeControlPlaneUpdateRestartSentinelBestEffort({
        meta: params.controlPlaneUpdateSentinelMeta,
        result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
        jsonMode: Boolean(params.opts.json),
      });
    if (!params.coreAlreadyCurrent) {
      await notifyRestart();
      await restoreWindowsAutoStart(resultWithPostUpdate);
    }
    let verificationFailure = "restart-unhealthy";
    const restart = async () => {
      const restarted = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        maybeRestartService({
          shouldRestart: shouldRestart && restartContext.serviceMutationAllowed,
          result: resultWithPostUpdate,
          opts: params.opts,
          refreshServiceEnv: restartContext.refreshGatewayServiceEnv,
          serviceLoadBoundary: params.serviceLoadBoundary,
          serviceUpdateVerdict: restartContext.serviceUpdateVerdict,
          serviceManagerUid: restartContext.serviceManagerUid,
          serviceRuntimeRefreshRequired: params.serviceRuntimeRefreshRequired,
          serviceEnv: restartContext.gatewayServiceEnv,
          serviceInstallEnv: restartContext.gatewayServiceInstallEnv,
          gatewayPort: restartContext.gatewayPort,
          restartScriptPath: restartContext.restartScriptPath,
          invocationCwd: params.invocationCwd,
          nodeRunner: params.packageUpdateNodeRunner,
          skipLegacyServiceRestart: restartContext.skipLegacyServiceRestart,
          requireRunningServiceAfterRestart: currentServiceStop()?.stopped === true,
          serviceMutationSkipMessage: restartContext.serviceMutationSkipMessage,
          timeoutMs: params.updateStepTimeoutMs,
          onVerificationFailure: (reason) => {
            verificationFailure = reason;
          },
          onPluginWarnings: (warnings) => {
            resultWithPostUpdate = appendPluginUpdateWarnings(resultWithPostUpdate, warnings);
          },
          onVerified: recordVerifiedDowntime,
        }),
      );
      if (restarted === "ok") {
        return;
      }
      triageAllowed = restartContext.serviceMutationAllowed;
      if (
        restarted === "restart-health-failed" &&
        params.shouldRestart &&
        restartContext.serviceMutationAllowed &&
        (params.preManagedServiceStop?.running !== false || params.preManagedServiceStop.stopped) &&
        !restartContext.skipLegacyServiceRestart
      ) {
        gateway = "verify-running";
      }
      const failure: UpdateRunResult = {
        ...resultWithPostUpdate,
        status: "error",
        reason: verificationFailure,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      };
      const recovered = await recoverFailedResult(
        failure,
        false,
        verificationFailure !== "service-runtime-refresh-failed" &&
          restartContext.serviceMutationAllowed &&
          !restartContext.skipLegacyServiceRestart &&
          !postVerificationRepairAttempted
          ? (result) =>
              repairUpdateService({
                result,
                root: postUpdateRoot,
                env:
                  params.ownedManagedUpdateEnv ??
                  params.opts.run?.env ??
                  restartContext.gatewayServiceEnv ??
                  restartContext.serviceStateReadEnv,
                opts: params.opts,
                gatewayPort: restartContext.gatewayPort,
                nodeRunner: params.packageUpdateNodeRunner,
                timeoutMs: params.updateStepTimeoutMs,
                invocationCwd: params.invocationCwd,
                expectedService: rollbackStopState ?? {
                  serviceManagerUid: restartContext.serviceManagerUid,
                  serviceEnv:
                    restartContext.gatewayServiceEnv ?? restartContext.serviceStateReadEnv,
                  serviceUpdateVerdict: restartContext.serviceUpdateVerdict,
                },
                recoveryStop: currentServiceStop(),
                onVerified: recordVerifiedDowntime,
              })
          : undefined,
      );
      if (recovered.result.status === "ok") {
        resultWithPostUpdate = recovered.result;
      } else {
        // The Gateway may have consumed its sentinel. Update only the existing
        // receipt so a failed repair cannot deliver a duplicate notification.
        await markControlPlaneUpdateRestartSentinelFailureBestEffort({
          meta: params.controlPlaneUpdateSentinelMeta,
          reason: recovered.result.reason ?? verificationFailure,
          jsonMode: Boolean(params.opts.json),
        });
        const reported = await reportResult(recovered.result, false, undefined, false);
        throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported));
      }
    };
    if (!params.coreAlreadyCurrent) {
      await restart();
    }
    if (deferPluginConvergence) {
      ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins(async () => {
        const before = currentServiceStop();
        if (!before) {
          throw new Error("Plugin maintenance lost its update service owner.");
        }
        await before.windowsTaskAutoStartRecovery?.complete(true);
        // Package work finished online. Full Doctor owns state migrations, so
        // park only now and retain this suspension through verified activation.
        const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
          updateRun: params.opts.run,
          updateInstallKind: resultWithPostUpdate.mode === "git" ? "git" : "package",
          root: postUpdateRoot,
          shouldRestart: true,
          jsonMode: Boolean(params.opts.json),
          expectedService: before,
          phase: "prepare",
          timeoutMs: params.updateStepTimeoutMs,
          onStopped: (state) => {
            rollbackStopState = state;
            pendingRestartAtMs ??= state.stoppedAtMs;
          },
        });
        rollbackStopState = stopped;
        before.windowsTaskAutoStartRecovery = stopped.windowsTaskAutoStartRecovery;
        if (stopped.blockMessage || !stopped.stopped) {
          throw new Error(
            stopped.blockMessage ?? "Gateway could not be parked for plugin maintenance.",
          );
        }
        stopped.windowsTaskAutoStartRecovery?.beginMutation();
        pendingRestartAtMs ??= stopped.stoppedAtMs;
      }));
      if (resultWithPostUpdate.postUpdate?.plugins?.changed) {
        // Convergence awaited package managers and plugin hooks. Revalidate the
        // exact native owner again before a changed plugin snapshot is activated.
        restartContext = await prepareUpdateRestart(
          {
            ...params,
            result: resultWithPostUpdate,
            shouldRestart,
            preManagedServiceStop: currentServiceStop(),
          },
          postUpdateConfigSnapshot ?? restartConfigSnapshot,
        );
        pendingRestartAtMs ??= Date.now();
        restartContext.restartScriptPath = null;
        if (!params.serviceRuntimeRefreshRequired) {
          restartContext.refreshGatewayServiceEnv = false;
        }
        await notifyRestart();
        await restoreWindowsAutoStart(resultWithPostUpdate);
        await restart();
      }
      return await reportResult(resultWithPostUpdate);
    }
    // Restart and health verification own recovery of the service stopped for this update.
    // Optional completion refresh must run only after that lifecycle boundary settles.
    await tryInstallShellCompletion({
      root: postUpdateRoot,
      jsonMode: Boolean(params.opts.json),
      skipPrompt: Boolean(params.opts.yes),
    });

    if (params.installKindChanged && resultWithPostUpdate.mode !== "git") {
      const retirement = await retireStandaloneGitWrapper({
        previousRoot: params.previousInstallRoot ?? params.root,
      });
      if (retirement.error) {
        defaultRuntime.error(retirement.error);
        await markControlPlaneUpdateRestartSentinelFailureBestEffort({
          meta: params.controlPlaneUpdateSentinelMeta,
          reason: "wrapper-retirement-failed",
          jsonMode: Boolean(params.opts.json),
        });
        const reported = await reportResult(
          {
            ...resultWithPostUpdate,
            status: "error",
            reason: "wrapper-retirement-failed",
          },
          false,
          undefined,
          false,
        );
        throw createFailure(reported, 1, retirement.error);
      }
    }

    return await reportResult(resultWithPostUpdate);
  } catch (error) {
    if (error instanceof UpdateCommandFailure || error instanceof UpdateServiceLoadBoundaryError) {
      // Staging may already have changed files. Keep intent/material for fenced reconciliation.
      throw error;
    }
    const message = formatErrorMessage(error);
    defaultRuntime.error(`Post-update verification failed: ${message}`);
    const reported = await reportResult({
      ...params.result,
      status: "error",
      reason: "post-update-failed",
      steps: [
        ...params.result.steps,
        {
          name: "post-update verification",
          command: "openclaw update",
          cwd: params.result.root ?? params.root,
          durationMs: Math.max(0, Date.now() - params.startedAt),
          exitCode: 1,
          stderrTail: message,
        },
      ],
    });
    throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
      cause: error,
    });
  }
}
