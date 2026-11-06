import { isUpdateDoctorInspectionReportMode } from "../../commands/doctor/shared/update-phase.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildControlPlaneUpdateRestartHealthPendingResult } from "../../infra/update-control-plane-sentinel.js";
import { unsafeUpdateRecovery } from "../../infra/update-recovery.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome, isVerifiedUpdateRollback } from "../../shared/update-outcome.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import {
  shouldWaitForRecovery,
  verifyUpdateFailureRecovery,
} from "./update-command-failure-recovery.js";
import type { FinishUpdateOptions, FinishUpdateParams } from "./update-command-finish-types.js";
import { parkForegroundUpdateForActivation } from "./update-command-handoff.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import { runPostActivationInspections } from "./update-command-post-activation-inspections.js";
import {
  completePostUpdateMaintenance,
  parkPostUpdateService,
  preparePostUpdateService,
  resumePostUpdateWindowsAutoStart,
  settlePostUpdateWindowsAutoStartFailure,
} from "./update-command-post-update-maintenance.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { assertUpdateCommandPackageFinalization } from "./update-command-recovery.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  recordServiceReconciliationWarning,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  recordUpdateResultNextAction,
  writeControlPlaneUpdateRestartSentinelBestEffort,
  withUpdateStateRead,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { GatewayRestartHealthError } from "./update-command-service-command.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import {
  admitInstalledGatewayRecovery,
  refuseUnsettledDoctorRecovery,
} from "./update-command-service-recovery.js";
import {
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
} from "./update-command-service.js";
import {
  completeUpdateCommandResult,
  captureUpdateFinalization,
  createPostUpdateExceptionResult,
  publishSettledUpdateCommandResult,
  shouldPropagatePostUpdateException,
  bindUpdateFinalizationFailure,
  withUpdateProgressSettlement,
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
  { beforeFinalization, ...options }: FinishUpdateOptions = {},
): Promise<UpdateRunResult> {
  const captured = captureUpdateFinalization(params);
  return await withUpdateProgressSettlement(params, beforeFinalization, (settled, failure) =>
    finishSettledUpdate(settled, options, captured, failure),
  );
}

async function finishSettledUpdate(
  params: FinishUpdateParams,
  {
    candidateRuntime = false,
    adoptedFinalization,
    onGatewayStartAttempted: observeGatewayStartAttempted,
  }: FinishUpdateOptions,
  captured: ReturnType<typeof captureUpdateFinalization>,
  progressFailure?: { cause: unknown },
): Promise<UpdateRunResult> {
  const { fence, assertCurrent, compensate, forward } = captured;
  let gatewayStartAttempted: "install" | "restart" | undefined;
  const onGatewayStartAttempted = (action: "install" | "restart" = "restart") => {
    gatewayStartAttempted = gatewayStartAttempted === "restart" ? gatewayStartAttempted : action;
    observeGatewayStartAttempted?.();
  };
  const definitionRecovery: UpdateServiceDefinitionRecovery = {};
  const parkForegroundOrigin = () => parkForegroundUpdateForActivation(params, assertCurrent);
  assertCurrent();
  await assertUpdateCommandPackageFinalization(params);
  const shouldRestart = progressFailure
    ? false
    : await preparePostUpdateService(params, assertCurrent);
  assertCurrent();
  const { createFailure, settleResult } = bindUpdateFinalizationFailure(progressFailure);
  let rollbackAttempted = false;
  let latestServiceStop = params.preManagedServiceStop;
  // Doctor parking and rollback replace this run's earlier service observation.
  const currentServiceStop = () => latestServiceStop;
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
  // Store the next action before the restarted Gateway can finish the row; refresh after recovery.
  assertCurrent();
  recordUpdateResultNextAction(params, params.result);

  let pendingResult = params.result;
  let settledResult: UpdateRunResult | undefined;
  let terminalRecord: UpdateCommandTerminalRecord | undefined;
  let pendingNotify = true;
  const writeRestartSentinel = (result: UpdateRunResult) =>
    writeControlPlaneUpdateRestartSentinelBestEffort({ ...captured.sentinelOptions, result });
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
    fence();
    if (params.databaseBackup?.restoreRefusal) {
      params.rollbackBlockedReason = "state-migrated-no-rollback";
    }
    let result = initialResult;
    if (refuseUnsettledDoctorRecovery(result, result.root ?? params.root, assertCurrent)) {
      return { result, recoverService: false };
    }
    let recoverService = initialRecoverService && !params.rollbackBlockedReason;
    if (
      result.status === "error" &&
      (params.packageTransaction ||
        params.rollbackBlockedReason ||
        params.originalManagedServiceRuntime) &&
      !rollbackAttempted &&
      !isUpdateGatewayReadinessPending(result)
    ) {
      rollbackAttempted = true;
      const rollback = await compensate(() =>
        withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () =>
          rollbackFailedUpdate({
            ...params,
            result,
            previousRoot: params.root,
            databaseBackup:
              captured.beganSuccessfully && !gatewayStartAttempted
                ? params.databaseBackup
                : undefined,
            allowGatewayRestart: params.shouldRestart,
            onGatewayStartAttempted,
            preManagedServiceStop: currentServiceStop(),
            timeoutMs: params.updateStepTimeoutMs,
            nodeRunner: params.packageUpdateNodeRunner,
            definitionRecovery,
          }),
        ),
      );
      if (params.originalManagedServiceRuntime && rollback.pendingRecoveryReason) {
        throw new UpdateCommandPendingRecoveryFailure(
          rollback.result,
          rollback.pendingRecoveryReason,
        );
      }
      result = rollback.result;
      originalServiceRecoveryHandled = rollback.originalServiceRecovery !== undefined;
      latestServiceStop = rollback.stoppedForRollback ?? currentServiceStop();
      rolledBack = rollback.rolledBack;
      pendingRestartAtMs ??= latestServiceStop?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (result.status === "error" && params.rollbackBlockedReason) {
      result = completeUpdateCommandResult(params, result);
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
    const recoveryParams = { ...params, preManagedServiceStop: currentServiceStop() };
    recoverService ||=
      !gatewayStartAttempted &&
      (await admitInstalledGatewayRecovery(recoveryParams, result, assertCurrent));
    if (recoverService) {
      params.rollbackBlockedReason = undefined;
    }
    if (isUpdateGatewayReadinessPending(result)) {
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
    const input = captured.interruptedResult(initialResult);
    const { result, recoverService } = await recoverFailedResult(input, initialRecoverService);
    assertCurrent();
    let restoreFailure = initialRestoreFailure;
    let finalResult = completeUpdateCommandResult(params, result, currentServiceStop());
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
          // Only a named data risk prohibits recovering the owned stopped service.
          if (
            finalResult.recovery?.serviceRestartSafe === false &&
            finalResult.recovery.dataAtRisk
          ) {
            await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
          }
        } else {
          await resumePostUpdateWindowsAutoStart(params, finalResult, currentServiceStop);
        }
      } catch (cause) {
        restoreFailure = { cause };
      }
    }
    if (restoreFailure) {
      rolledBack = false;
      restoreFailure = await settlePostUpdateWindowsAutoStartFailure(
        params,
        finalResult,
        result,
        restoreFailure.cause,
        currentServiceStop,
      );
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
    // Persist the startup notification once; rewriting a consumed sentinel could deliver it twice.
    if (recoverService && finalResult.recovery?.serviceRestartSafe === true) {
      const service = await maybeRestartServiceAfterFailedMutableUpdate({
        onGatewayStartAttempted,
        recovery: finalResult.recovery,
        originalManagedServiceRuntime: params.originalManagedServiceRuntime,
        updateRun: params.opts.run,
        preManagedServiceStop: currentServiceStop(),
        jsonMode: Boolean(params.opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      });
      if (service && !params.originalManagedServiceRuntime) {
        root = serviceVerdict && "root" in serviceVerdict ? serviceVerdict.root : root;
        finalResult.recovery = { ...finalResult.recovery, service };
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
    assertCurrent();
    const cleanupFailure = await recordUpdatePackageCompletion(params, finalResult, assertCurrent);
    assertCurrent();
    finalResult = cleanupFailure?.result ?? finalResult;
    // Rollback already verified its Gateway; cleanup failure needs a fresh observation.
    const needsObservation = cleanupFailure || (!rolledBack && finalResult.status === "error");
    if (needsObservation && !originalServiceRecoveryHandled) {
      finalResult = await verifyUpdateFailureRecovery({
        result: finalResult,
        root,
        opts: params.opts,
        env: currentServiceStop()?.serviceEnv ?? params.ownedManagedUpdateEnv,
        timeoutMs: params.updateStepTimeoutMs,
        mutationStarted: params.mutationStarted,
        preManagedServiceStop: currentServiceStop(),
        gatewayStartAttempted,
        definitionRecovery,
        onGatewayStartAttempted,
        nodeRunner: params.packageUpdateNodeRunner,
        invocationCwd: params.invocationCwd,
        serviceStopped: !rolledBack && currentServiceStop()?.stopped,
        serviceUpdateVerdict: gatewayStartAttempted
          ? undefined
          : currentServiceStop()?.serviceUpdateVerdict,
        waitForStartup: shouldWaitForRecovery(params, currentServiceStop(), rollbackAttempted),
        assertCurrent,
      });
      assertCurrent();
      rolledBack &&= isVerifiedUpdateRollback(finalResult);
    }
    // Retain compensation until final recovery settles its restart readiness check.
    try {
      await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(
        rolledBack ||
          isUpdateGatewayReadinessPending(finalResult) ||
          finalResult.status === "ok" ||
          (finalResult.recovery?.serviceRestartSafe === true &&
            finalResult.recovery.service === "healthy"),
      );
    } catch (cause) {
      rolledBack = false;
      restoreFailure = await settlePostUpdateWindowsAutoStartFailure(
        params,
        finalResult,
        result,
        cause,
        currentServiceStop,
      );
    }
    pendingResult = completeUpdateCommandResult(params, captured.interruptedResult(finalResult));
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
      // Persist before unwinding; keep both failures with failed compensation as the primary cause.
      const priorDetail = [result.reason, params.failure?.detail].filter(Boolean).join(": ");
      const detail =
        `${priorDetail ? `${priorDetail}; ` : ""}Windows Scheduled Task autostart recovery failed: ` +
        formatErrorMessage(restoreFailure.cause);
      const cause = params.failure
        ? new AggregateError([params.failure.cause, restoreFailure.cause], detail, {
            cause: restoreFailure.cause,
          })
        : restoreFailure.cause;
      throw createFailure(reportedResult, detail, { cause });
    }
    settledResult = reportedResult;
    return reportedResult;
  };
  const restoreWindowsAutoStart = (result: UpdateRunResult) =>
    resumePostUpdateWindowsAutoStart(params, result, currentServiceStop, {
      onFailure: (cause) => reportResult(result, false, { cause }),
    });

  let resultWithPostUpdate = params.result;
  let activationVerified = false;
  const runPostUpdate = async (): Promise<UpdateRunResult> => {
    try {
      if (params.coreAlreadyCurrent && params.deferredMaintenance) {
        defaultRuntime.error(params.deferredMaintenance);
        return params.result;
      }
      if (
        params.result.status === "error" ||
        params.result.recovery?.serviceRestartSafe === false
      ) {
        const reported = await reportResult(
          { ...params.result, status: "error" },
          params.result.recovery?.serviceRestartSafe === true,
        );
        return settleResult(reported, params.failure?.detail, params.failure);
      }

      if (params.result.status === "skipped" && !params.coreAlreadyCurrent) {
        const reported = await reportResult(
          params.result,
          params.result.recovery?.serviceRestartSafe === true,
        );
        throw createFailure(
          reported,
          undefined,
          undefined,
          classifyUpdateOutcome(reported) === "failed" ? undefined : 0,
        );
      }

      const postUpdateRoot = params.result.root ?? params.root;
      // Only current-core convergence runs online, parking before fresh Doctor.
      const deferPluginConvergence =
        shouldRestart &&
        params.preManagedServiceStop?.serviceMutationAllowed !== false &&
        params.coreAlreadyCurrent === true &&
        params.preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned";
      const runsPostActivationInspections =
        shouldRestart &&
        (!params.coreAlreadyCurrent || deferPluginConvergence) &&
        (!candidateRuntime ||
          adoptedFinalization ||
          isUpdateDoctorInspectionReportMode(process.env));
      const convergePlugins = async (beforeDoctor?: () => Promise<void>) => {
        const pluginParams = {
          ...params,
          beforeDoctor: beforeDoctor ?? parkForegroundOrigin,
          beforeRuntimePublication: parkForegroundOrigin,
          assertCurrent,
          candidateRuntime,
          deferPostActivationInspections: runsPostActivationInspections,
        };
        const convergence = await forward(() => convergeUpdatePlugins(pluginParams));
        if (convergence.resultWithPostUpdate.status === "error") {
          const reported = await reportResult(convergence.resultWithPostUpdate);
          throw createFailure(reported, convergence.detail);
        }
        return convergence;
      };
      let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
      if (!deferPluginConvergence) {
        ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins());
        if (params.coreAlreadyCurrent) {
          if (
            params.preManagedServiceStop?.serviceUpdateVerdict?.kind === "absent" &&
            params.preManagedServiceStop.serviceMutationSkipMessage
          ) {
            // Explain the absent service without claiming completed service-install maintenance.
            defaultRuntime.error(params.preManagedServiceStop.serviceMutationSkipMessage);
          } else if (params.preManagedServiceStop?.serviceMutationSkipMessage) {
            recordServiceReconciliationWarning(
              resultWithPostUpdate,
              params.preManagedServiceStop.serviceEnv ?? process.env,
              params.preManagedServiceStop.serviceMutationSkipMessage,
            );
          }
          return resultWithPostUpdate;
        }
      }
      const restartConfigSnapshot =
        postUpdateConfigSnapshot ??
        (await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
          withUpdateStateRead(
            () =>
              readConfigFileSnapshot({
                observe: false,
                skipPluginValidation: true,
                suppressFutureVersionWarning: true,
              }),
            params.opts.run?.deadline?.remainingMs() ?? params.updateStepTimeoutMs,
          ),
        ));
      let restartContext: Awaited<ReturnType<typeof prepareUpdateRestart>>;
      try {
        restartContext = await withUpdateStateRead(
          () =>
            prepareUpdateRestart(
              { ...params, shouldRestart, result: resultWithPostUpdate, assertCurrent },
              restartConfigSnapshot,
            ),
          params.opts.run?.deadline?.remainingMs() ?? params.updateStepTimeoutMs,
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
        throw createFailure(reported, message, { cause: error });
      }
      const notifyRestart = () =>
        writeRestartSentinel(
          buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
        );
      if (!params.coreAlreadyCurrent) {
        await notifyRestart();
        await restoreWindowsAutoStart(resultWithPostUpdate);
      }
      let verificationFailure = "restart-unhealthy";
      const restart = async () => {
        const restarted = await forward(() =>
          maybeRestartService({
            onGatewayStartAttempted,
            originalManagedServiceRuntime: params.originalManagedServiceRuntime,
            shouldRestart: shouldRestart && restartContext.serviceMutationAllowed,
            observePackageReplacement:
              params.opts.restart === false && currentServiceStop()?.running === true,
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
            onVerified: (verifiedAtMs) => {
              activationVerified = true;
              recordVerifiedDowntime(verifiedAtMs);
            },
          }),
        );
        if (restarted !== "failed" && restarted !== "restart-health-failed") {
          return restarted === "ok";
        }
        if (activationVerified && restarted === "restart-health-failed") {
          throw new GatewayRestartHealthError(`Restart finalization: ${verificationFailure}.`);
        }
        const failure: UpdateRunResult = {
          ...resultWithPostUpdate,
          status: "error",
          reason: verificationFailure,
          recovery: unsafeUpdateRecovery(resultWithPostUpdate.recovery),
        };
        const recovered = await recoverFailedResult(failure, false);
        if (recovered.result.status !== "ok") {
          // The Gateway may have consumed its sentinel. Update only the existing
          // receipt so the terminal failure cannot deliver a duplicate notification.
          await markControlPlaneUpdateRestartSentinelFailureBestEffort({
            ...captured.sentinelOptions,
            reason: recovered.result.reason ?? verificationFailure,
          });
          const reported = await reportResult(recovered.result, false, undefined, false);
          return settleResult(reported);
        }
        resultWithPostUpdate = recovered.result;
        return true;
      };
      if (!params.coreAlreadyCurrent) {
        const recovered = await restart();
        if (typeof recovered !== "boolean") {
          return recovered;
        }
      }
      if (deferPluginConvergence) {
        ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins(async () => {
          const stopped = await parkPostUpdateService(params, {
            before: currentServiceStop(),
            updateRun: captured.originalRun,
            recordPhase: captured.recordPhase,
            assertCurrent,
            mode: resultWithPostUpdate.mode,
            root: postUpdateRoot,
            onStopped: (state) => {
              latestServiceStop = state;
              pendingRestartAtMs ??= state.stoppedAtMs;
            },
            onPrepared: (state) => {
              latestServiceStop = state;
            },
          });
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
          // Native installation-only repair owns replacement/rollback while the old Gateway serves.
          // Revalidate its owner after convergence awaits, before activating plugins or Node.
          restartContext = await prepareUpdateRestart(
            {
              ...params,
              result: resultWithPostUpdate,
              shouldRestart,
              preManagedServiceStop: currentServiceStop(),
              assertCurrent,
            },
            postUpdateConfigSnapshot ?? restartConfigSnapshot,
          );
          pendingRestartAtMs ??= Date.now();
          if (!params.serviceRuntimeRefreshRequired && !requiresInstallRootRefresh) {
            restartContext.refreshGatewayServiceEnv = false;
          }
          await notifyRestart();
          await restoreWindowsAutoStart(resultWithPostUpdate);
          const reconciled = await restart();
          if (typeof reconciled !== "boolean") {
            return reconciled;
          }
          if (
            requiresInstallRootRefresh &&
            reconciled &&
            resultWithPostUpdate.status === "skipped"
          ) {
            resultWithPostUpdate.status = "ok";
            delete resultWithPostUpdate.reason;
          }
        }
      }
      // Only an observed target Doctor can leave inspections for this owner.
      // A parking hook or unchanged plugin phase is not a Doctor receipt.
      if (
        resultWithPostUpdate.status === "ok" &&
        runsPostActivationInspections &&
        resultWithPostUpdate.steps.some((step) => step.deferredInspectionCheckIds !== undefined)
      ) {
        assertCurrent();
        resultWithPostUpdate = await forward(() =>
          runPostActivationInspections({
            root: postUpdateRoot,
            result: resultWithPostUpdate,
            gatewayReady: activationVerified,
            timeoutMs: params.updateStepTimeoutMs,
            nodeRunner: params.packageUpdateNodeRunner,
            ownedManagedUpdateEnv: params.ownedManagedUpdateEnv,
          }),
        );
      }
      if (deferPluginConvergence) {
        return resultWithPostUpdate;
      }
      const maintenanceFailure = await completePostUpdateMaintenance(
        params,
        resultWithPostUpdate,
        assertCurrent,
        { root: postUpdateRoot, sentinel: captured.sentinelOptions, activationVerified },
      );
      if (maintenanceFailure) {
        const reported = await reportResult(maintenanceFailure.result, false, undefined, false);
        throw createFailure(reported, maintenanceFailure.detail, undefined, 1);
      }

      return resultWithPostUpdate;
    } catch (error) {
      if (
        params.originalManagedServiceRuntime &&
        error instanceof UpdateCommandRecoveryPendingError
      ) {
        throw new UpdateCommandPendingRecoveryFailure(pendingResult, formatErrorMessage(error), {
          cause: error,
        });
      }
      if (shouldPropagatePostUpdateException(error, activationVerified)) {
        // Unsettled commands may still change files. Keep intent/material for fenced reconciliation.
        throw error;
      }
      const { result, message } = createPostUpdateExceptionResult(
        { ...params, result: resultWithPostUpdate },
        error,
        activationVerified,
      );
      if (result.status === "ok") {
        assertCurrent();
        defaultRuntime.error(message);
        return result;
      }
      defaultRuntime.error(`Post-update verification failed: ${message}`);
      const reported = await reportResult(result);
      throw createFailure(reported, message, { cause: error });
    }
  };
  // Reporting cannot revoke verified activation or authorize another native rollback.
  const result = await runPostUpdate();
  return settledResult === result ? result : await reportResult(result);
}
