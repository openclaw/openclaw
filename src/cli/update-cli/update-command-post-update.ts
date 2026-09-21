import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  resolveManagedServiceUpdateFailureExitCode,
} from "../../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome, isVerifiedUpdateRollback } from "../../shared/update-outcome.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { verifyUpdateFailureRecovery } from "./update-command-failure-recovery.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { parkForegroundUpdateForActivation } from "./update-command-handoff.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import {
  completePostUpdateMaintenance,
  resumePostUpdateWindowsAutoStart,
} from "./update-command-post-update-maintenance.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  assertUpdateCommandPackageFinalization,
  createUpdateCommandFinalizationFence,
} from "./update-command-recovery.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  prepareUpdateServiceResult,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  resolveAutomaticUpdateTriage,
  recordUpdateResultNextAction,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import {
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import {
  completeUpdateCommandResult,
  createPostUpdateFailureResult,
  publishSettledUpdateCommandResult,
} from "./update-command-terminal-publication.js";
import {
  captureUpdateCommandTerminalRecord,
  type UpdateCommandTerminalRecord,
} from "./update-command-terminal-record.js";
import {
  deferUpdateCommandTerminalResult,
  recordUpdatePackageCompletion,
} from "./update-command-terminal.js";

export async function finishUpdate(
  params: FinishUpdateParams,
  { candidateRuntime = false } = {},
): Promise<UpdateRunResult> {
  const definitionRecovery: UpdateServiceDefinitionRecovery = {};
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  const parkForegroundOrigin = () => parkForegroundUpdateForActivation(params, assertCurrent);

  // Final publication follows restoration of the caller's environment. Retain
  // the admitted run's state for both notice policy and its matching sentinel.
  const sentinelOptions = {
    meta: params.controlPlaneUpdateSentinelMeta,
    jsonMode: Boolean(params.opts.json),
    env: params.opts.run?.env ?? params.ownedManagedUpdateEnv,
  };
  assertCurrent();
  await assertUpdateCommandPackageFinalization(params);
  assertCurrent();
  const shouldRestart = prepareUpdateServiceResult(params);
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
  let rollbackStopState: PreManagedServiceStop | undefined;
  // Rollback can replace the suspension owner.
  const currentServiceStop = () => rollbackStopState ?? params.preManagedServiceStop;
  let rolledBack = false;
  let originalServiceRecoveryHandled = false;
  let completedDowntimeMs: number | undefined = params.coreAlreadyCurrent ? 0 : undefined;
  let pendingRestartAtMs =
    params.preManagedServiceStop?.stoppedAtMs ??
    params.controlPlaneUpdateSentinelMeta?.serviceStoppedAtMs;
  // Retain completed outages across verification resets and rollback until final reporting.
  const recordVerifiedDowntime = (verifiedAtMs: number) => {
    if (pendingRestartAtMs !== undefined) {
      completedDowntimeMs =
        (completedDowntimeMs ?? 0) + Math.max(0, verifiedAtMs - pendingRestartAtMs);
      pendingRestartAtMs = undefined;
    }
  };
  // Restart can let the new Gateway finish the row before CLI finalization resumes.
  // Store the next action before that handoff, and refresh it if recovery changes the outcome.
  assertCurrent();
  recordUpdateResultNextAction(params, params.result);

  let pendingResult = params.result;
  let terminalRecord: UpdateCommandTerminalRecord | undefined;
  let pendingNotify = true;
  const writeRestartSentinel = (result: UpdateRunResult) =>
    writeControlPlaneUpdateRestartSentinelBestEffort({ ...sentinelOptions, result });
  const publishFinalResult = (
    failure?: unknown,
    onTerminalRecord?: (record: UpdateCommandTerminalRecord["record"]) => void,
  ) =>
    publishSettledUpdateCommandResult(
      params,
      {
        pendingResult,
        failure,
        terminalRecord,
        readReportingState: () => ({
          notify: pendingNotify ? writeRestartSentinel : undefined,
          rolledBack,
          pendingRestartAtMs,
          completedDowntimeMs,
        }),
      },
      onTerminalRecord,
    );
  const deferredTerminal = deferUpdateCommandTerminalResult(params.opts.run, publishFinalResult);
  const recoverFailedResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService: boolean,
  ) => {
    assertCurrent();
    let result = initialResult;
    let recoverService = initialRecoverService;
    if (
      result.status === "error" &&
      (params.packageTransaction ||
        params.rollbackBlockedReason ||
        params.originalManagedServiceRuntime) &&
      !rollbackAttempted &&
      !isUpdateGatewayReadinessPending(result)
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
          originalManagedServiceRuntime: params.originalManagedServiceRuntime,
          allowGatewayRestart: params.shouldRestart,
          configSnapshot: params.configSnapshot,
          activationConfig: params.activationConfig,
          opts: params.opts,
          preManagedServiceStop: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          invocationCwd: params.invocationCwd,
          definitionRecovery,
        }),
      );
      if (params.originalManagedServiceRuntime && rollback.pendingRecoveryReason) {
        throw new UpdateCommandPendingRecoveryFailure(
          rollback.result,
          rollback.pendingRecoveryReason,
        );
      }
      result = rollback.result;
      originalServiceRecoveryHandled = rollback.originalServiceRecovery !== undefined;
      rollbackStopState = rollback.stoppedForRollback;
      rolledBack = rollback.rolledBack;
      pendingRestartAtMs ??= rollbackStopState?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (result.status === "error" && params.rollbackBlockedReason) {
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
    if (isUpdateGatewayReadinessPending(result)) {
      triageAllowed = false;
      return { result, recoverService: false };
    }
    return { result, recoverService };
  };
  const reportResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService = false,
    initialRestoreFailure?: { cause: unknown },
    notify = true,
  ): Promise<UpdateRunResult> => {
    const { result, recoverService } = await recoverFailedResult(
      initialResult,
      initialRecoverService,
    );
    assertCurrent();
    let restoreFailure = initialRestoreFailure;
    let finalResult = completeUpdateCommandResult(params, result);
    const serviceVerdict = currentServiceStop()?.serviceUpdateVerdict;
    let root =
      finalResult.recovery?.packageRollbackVerified && serviceVerdict?.kind === "owned"
        ? serviceVerdict.root
        : (finalResult.root ?? params.root);
    pendingResult = finalResult;
    pendingNotify = notify;
    if (!restoreFailure) {
      try {
        if (
          !rolledBack &&
          finalResult.status !== "ok" &&
          !isUpdateGatewayReadinessPending(finalResult) &&
          finalResult.recovery?.serviceRestartSafe !== true
        ) {
          await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
        } else {
          await resumePostUpdateWindowsAutoStart(params, finalResult, currentServiceStop());
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
      finalResult.steps = finalResult.steps.concat({
        name: "windows-task-autostart-recovery",
        command: "openclaw update",
        cwd: finalResult.root ?? params.root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: formatErrorMessage(restoreFailure.cause),
      });
    }
    const completedBeforeCleanup = deferredTerminal
      ? await captureUpdateCommandTerminalRecord(params, finalResult, assertCurrent)
      : undefined;
    assertCurrent();
    recordUpdateResultNextAction(params, finalResult, completedBeforeCleanup?.record);
    if (notify && recoverService) {
      pendingNotify = false;
      await writeRestartSentinel(finalResult);
    }
    // The recovering Gateway reads this notification at startup. Persist once
    // before restarting; rewriting a consumed sentinel could deliver it twice.
    if (recoverService && finalResult.recovery?.serviceRestartSafe === true) {
      const service = await maybeRestartServiceAfterFailedMutableUpdate({
        recovery: result.recovery,
        originalManagedServiceRuntime: params.originalManagedServiceRuntime,
        updateRun: params.opts.run,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      });
      if (service && !params.originalManagedServiceRuntime) {
        root = serviceVerdict && "root" in serviceVerdict ? serviceVerdict.root : root;
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
        isUpdateGatewayReadinessPending(finalResult) ||
        finalResult.status === "ok" ||
        (finalResult.recovery?.serviceRestartSafe === true &&
          finalResult.recovery.service === "healthy"),
    );
    assertCurrent();
    const cleanupFailure = await recordUpdatePackageCompletion(params, finalResult, assertCurrent);
    assertCurrent();
    finalResult = cleanupFailure?.result ?? finalResult;
    // Compensation of the original service is not proof of the requested installation.
    if ((finalResult.status === "error" || cleanupFailure) && !originalServiceRecoveryHandled) {
      finalResult = await verifyUpdateFailureRecovery({
        result: finalResult,
        root,
        opts: params.opts,
        env: currentServiceStop()?.serviceEnv ?? params.ownedManagedUpdateEnv,
        timeoutMs: params.updateStepTimeoutMs,
        serviceStopped: !rolledBack && currentServiceStop()?.stopped,
        assertCurrent,
      });
      assertCurrent();
      triageAllowed &&= !isUpdateGatewayReadinessPending(finalResult);
      rolledBack &&= isVerifiedUpdateRollback(finalResult);
    }
    pendingResult = completeUpdateCommandResult(params, finalResult);
    terminalRecord = deferredTerminal
      ? await captureUpdateCommandTerminalRecord(params, pendingResult, assertCurrent)
      : undefined;
    assertCurrent();
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
      await resumePostUpdateWindowsAutoStart(params, result, currentServiceStop());
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
      const pluginParams = {
        ...params,
        beforeDoctor: beforeDoctor ?? parkForegroundOrigin,
        beforeRuntimePublication: parkForegroundOrigin,
        assertCurrent,
        candidateRuntime,
      };
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
      writeRestartSentinel(buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate));
    if (!params.coreAlreadyCurrent) {
      await notifyRestart();
      await restoreWindowsAutoStart(resultWithPostUpdate);
    }
    let verificationFailure = "restart-unhealthy";
    const restart = async () => {
      const restarted = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        maybeRestartService({
          originalManagedServiceRuntime: params.originalManagedServiceRuntime,
          shouldRestart: shouldRestart && restartContext.serviceMutationAllowed,
          result: resultWithPostUpdate,
          opts: params.opts,
          refreshServiceEnv: restartContext.refreshGatewayServiceEnv,
          definitionRecovery,
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
      if (restarted !== "failed" && restarted !== "restart-health-failed") {
        return restarted === "ok";
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
      const recovered = await recoverFailedResult(failure, false);
      if (recovered.result.status !== "ok") {
        // The Gateway may have consumed its sentinel. Update only the existing
        // receipt so the terminal failure cannot deliver a duplicate notification.
        await markControlPlaneUpdateRestartSentinelFailureBestEffort({
          ...sentinelOptions,
          reason: recovered.result.reason ?? verificationFailure,
        });
        const reported = await reportResult(recovered.result, false, undefined, false);
        throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported));
      }
      resultWithPostUpdate = recovered.result;
      return true;
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
      const requiresInstallRootRefresh =
        restartContext.serviceUpdateVerdict?.kind === "owned" &&
        restartContext.serviceUpdateVerdict.requiresInstallRootRefresh;
      if (
        resultWithPostUpdate.postUpdate?.plugins?.changed ||
        params.serviceRuntimeRefreshRequired ||
        requiresInstallRootRefresh
      ) {
        // Installation-only repair keeps the old Gateway serving; the native
        // installer owns replacement and rollback with its actual running state.
        // Convergence awaited package managers and plugin hooks. Revalidate the
        // exact native owner before activating plugins or the selected Node runtime.
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
        if (!params.serviceRuntimeRefreshRequired && !requiresInstallRootRefresh) {
          restartContext.refreshGatewayServiceEnv = false;
        }
        await notifyRestart();
        await restoreWindowsAutoStart(resultWithPostUpdate);
        const reconciled = await restart();
        if (requiresInstallRootRefresh && reconciled && resultWithPostUpdate.status === "skipped") {
          resultWithPostUpdate.status = "ok";
          delete resultWithPostUpdate.reason;
        }
      }
      return await reportResult(resultWithPostUpdate);
    }
    const maintenanceFailure = await completePostUpdateMaintenance(
      params,
      resultWithPostUpdate,
      assertCurrent,
      { root: postUpdateRoot, sentinel: sentinelOptions },
    );
    if (maintenanceFailure) {
      const reported = await reportResult(maintenanceFailure.result, false, undefined, false);
      throw createFailure(reported, 1, maintenanceFailure.detail);
    }

    return await reportResult(resultWithPostUpdate);
  } catch (error) {
    if (
      params.originalManagedServiceRuntime &&
      error instanceof UpdateCommandRecoveryPendingError
    ) {
      throw new UpdateCommandPendingRecoveryFailure(pendingResult, formatErrorMessage(error), {
        cause: error,
      });
    }
    if (error instanceof UpdateCommandFailure || hasCommandProcessCleanupError(error)) {
      // Unsettled commands may still change files. Keep intent/material for fenced reconciliation.
      throw error;
    }
    const { result, message } = createPostUpdateFailureResult(params, error);
    defaultRuntime.error(`Post-update verification failed: ${message}`);
    const reported = await reportResult(result);
    throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
      cause: error,
    });
  }
}
