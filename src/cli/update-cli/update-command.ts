import { theme } from "../../../packages/terminal-core/src/theme.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import type { RetainUpdateRuntime } from "../../infra/update-retained-runtime.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { resolveDebugProxySettings } from "../../proxy-capture/env.js";
import { withDeferredDebugProxyCapture } from "../../proxy-capture/runtime-deferral.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { createUpdateProgress } from "./progress.js";
import {
  confirmUpdateDowngrade,
  resolveGitInstallDir,
  type UpdateCommandOptions,
} from "./shared.js";
import { withUpdateCandidateAdmission } from "./update-command-candidate-admission.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";
import type { UpdateCommandExecutorOptions } from "./update-command-executor-options.js";
import {
  captureUpdateCommandExecutorAuthority,
  type UpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { InitializedUpdate } from "./update-command-initialization.js";
import { admitUpdateRequesterContinuation } from "./update-command-managed-context.js";
import { preparePackageUpdateRuntime } from "./update-command-node-runtime.js";
import type { StagedPackageInstallUpdate } from "./update-command-package.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  withUpdateAdmissionReporting,
} from "./update-command-result.js";
import {
  admitUpdateCommandRun,
  assertUpdatePackageActivationAdmission,
  createUpdateRunProgress,
  prepareUpdateCommand,
  prepareMutableUpdateRuntime,
  resolveUpdateCommandAdmissionEnv,
  resolveUpdateCommandAdmissionRoot,
  withUpdatePreviewSignals,
} from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportPreMutationUpdateResult,
  prepareUnexpectedUpdateCommandFailure,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

type PreparedUpdate = NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>;

export async function updateCommand(
  inputOpts: UpdateCommandOptions,
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  return await withDeferredDebugProxyCapture(async () => {
    const { withRetainedUpdateRuntime } = await import("../../infra/update-retained-runtime.js");
    return await withRetainedUpdateRuntime(import.meta.url, (retainRuntime) =>
      updateCommandWithRuntime(inputOpts, retainRuntime, executorOptions),
    );
  });
}

async function updateCommandWithRuntime(
  inputOpts: UpdateCommandOptions,
  retainRuntime: RetainUpdateRuntime,
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  const invocationCwd = tryProcessCwd();
  const recoveryState: UpdateCommandRecoveryState = {
    triageTarget: { env: resolveServiceRefreshEnv(process.env, invocationCwd) },
  };
  // Rejected arguments and handoffs must not open or recover persistent state.
  const prepared = await withUpdateAdmissionReporting(inputOpts, () =>
    withUpdateInProgressEnv(invocationCwd, () => prepareUpdateCommand(inputOpts)),
  );
  // Post-core children report phase results; the outer updater owns the run ledger.
  if (prepared.postCoreUpdateResume) {
    return await withUpdateInProgressEnv(invocationCwd, async () =>
      (await import("./update-execution.runtime.js")).resumePostCoreUpdate({
        root: prepared.discoveredRoot,
        channel: prepared.postCoreUpdateChannel,
        opts: inputOpts,
        timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      }),
    );
  }
  return await withUpdateAdmissionReporting(inputOpts, async () => {
    const root = prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot;
    const serviceRoot = prepared.servicePlan?.serviceRoot;
    const env = await resolveUpdateCommandAdmissionEnv({
      opts: inputOpts,
      root: resolveUpdateCommandAdmissionRoot(prepared),
      invocationCwd,
      pkgOwnership: prepared.pkgOwnership,
      expectedForeground:
        prepared.controlPlaneUpdateSentinelMeta?.completionOwner === "gateway-restart" || undefined,
    });
    if (inputOpts.dryRun && resolveDebugProxySettings(env).enabled) {
      defaultRuntime.error("Warning: Debug HTTP capture is disabled during update dry runs.");
    }
    const { updateStateNeedsInitialization } = await import("./update-command-initialization.js");
    assertUpdatePackageActivationAdmission(root, { serviceRoot });
    const needsInitialization = await updateStateNeedsInitialization(env);
    const captureOriginal =
      !inputOpts.dryRun &&
      !inputOpts.run &&
      !inputOpts.recovery &&
      !executorOptions &&
      !env[UPDATE_RUN_ID_ENV]?.trim() &&
      env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1";
    const execute = (initialization?: InitializedUpdate) =>
      runAdmittedUpdate(
        inputOpts,
        prepared,
        recoveryState,
        invocationCwd,
        retainRuntime,
        initialization,
        executorOptions,
      );
    if (needsInitialization || captureOriginal) {
      const { initializeAndRunUpdate } = await import("./update-command-initialization-run.js");
      return await initializeAndRunUpdate(
        inputOpts,
        prepared,
        recoveryState,
        invocationCwd,
        env,
        execute,
        { needsInitialization, captureOriginal },
        executorOptions,
      );
    }
    return await execute();
  });
}

async function runAdmittedUpdate(
  inputOpts: UpdateCommandOptions,
  prepared: PreparedUpdate,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  retainRuntime: RetainUpdateRuntime,
  initialization?: InitializedUpdate,
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  const refusal = initialization?.refusal;
  const serviceRoot = initialization
    ? initialization.refusal
      ? initialization.refusal.report.serviceRoot
      : initialization.target.managedServiceRoot
    : prepared.servicePlan?.serviceRoot;
  let initializedFence: UpdateRecoveryFence | undefined;
  let assertInitializationCurrent: (() => void) | undefined;
  if (initialization) {
    const root = initialization.refusal
      ? initialization.refusal.report.root
      : initialization.target.root;
    const fence = await initialization.executor.enter(root, { preflight: true, serviceRoot });
    initializedFence = fence;
    assertInitializationCurrent = () => {
      fence.assertCurrent();
      assertUpdatePackageActivationAdmission(root, { serviceRoot });
    };
  }
  const run = await admitUpdateCommandRun({
    opts: inputOpts,
    root: resolveUpdateCommandAdmissionRoot(prepared),
    serviceRoot,
    invocationCwd,
    initialization,
    assertCurrent: assertInitializationCurrent,
    pkgOwnership: prepared.pkgOwnership,
    expectedForeground:
      prepared.controlPlaneUpdateSentinelMeta?.completionOwner === "gateway-restart" || undefined,
    installKind: prepared.installKind,
  });
  const opts = { ...inputOpts, run };
  prepared.controlPlaneUpdateSentinelMeta = {
    ...prepared.controlPlaneUpdateSentinelMeta,
    runId: run.runId,
  };
  recoveryState.triageTarget.root = prepared.discoveredRoot;
  let disposePresentation: (() => void) | undefined;
  let executionStarted = false;
  try {
    assertInitializationCurrent?.();
    run.executorFence = initializedFence;
    await initialization?.registerRun(run);
    const presentation = createUpdateProgress(!opts.json, run);
    disposePresentation = presentation.dispose;
    const executeWith = (executor: UpdateCommandExecutor) =>
      withUpdatePreviewSignals(opts, async () => {
        await admitUpdateRequesterContinuation(
          run,
          executor,
          resolveUpdateCommandAdmissionRoot(prepared),
          serviceRoot,
        );
        const execute = () => {
          executionStarted = true;
          if (refusal) {
            assertInitializationCurrent?.();
            throw refusal;
          }
          return withUpdateCommandRecoveryUnwind(opts, recoveryState, () =>
            updateCommandInternal(
              opts,
              recoveryState,
              invocationCwd,
              prepared,
              presentation,
              executor,
              retainRuntime,
              initialization,
            ),
          );
        };
        if (inputOpts.dryRun || !prepared.controlPlaneUpdateSentinelMeta?.handoffId) {
          return execute();
        }
        // The admitted helper owns native stop and recovery for this invocation.
        // A handoff tuple alone never grants authority to an ordinary service caller.
        const fence =
          run.executorFence ??
          (await executor.enter(
            prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
            {
              preflight: true,
              serviceRoot: prepared.servicePlan?.serviceRoot,
            },
          ));
        run.executorFence = fence;
        const runId = run.runId;
        const assertCurrent = () => {
          if (opts.run !== run || run.runId !== runId || run.executorFence !== fence) {
            throw new UpdateCommandRecoveryPendingError(
              "Managed updater lost its admitted executor.",
            );
          }
          captureUpdateCommandExecutorAuthority(fence, runId);
        };
        return withGatewayServiceUpdateAuthority(assertCurrent, execute, {
          originalRoot: captureUpdateCommandExecutorAuthority(fence, runId).installKey,
        });
      });
    const execute = initialization
      ? () => executeWith(initialization.executor)
      : () =>
          withUpdateFailureTriage({ ...opts, invocationCwd }, recoveryState.triageTarget, () =>
            withUpdateInProgressEnv(invocationCwd, () =>
              withUpdateCommandTerminalResult((registerRun) => {
                registerRun(run);
                return withUpdateCommandExecutor(run.runId, executeWith, executorOptions);
              }, opts),
            ),
          );
    await execute();
  } catch (error) {
    // Execution owns recovery; only failures before execution starts are terminalized here.
    if (!executionStarted) {
      throw await prepareUnexpectedUpdateCommandFailure(error, opts);
    }
    throw error;
  } finally {
    disposePresentation?.();
  }
}

async function updateCommandInternal(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  prepared: PreparedUpdate,
  presentation: ReturnType<typeof createUpdateProgress>,
  executor: UpdateCommandExecutor,
  retainRuntime: RetainUpdateRuntime,
  initialization?: InitializedUpdate,
): Promise<void> {
  const run = opts.run!;
  const updateStepTimeoutMs =
    prepared.timeoutMs ?? run.defaultStepTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  const target =
    initialization?.target ??
    (await resolveUpdateCommandTarget(
      opts,
      recoveryState,
      invocationCwd,
      prepared,
      executor,
      updateStepTimeoutMs,
    ));
  if (!target) {
    return;
  }
  return await withUpdateCandidateAdmission(
    {
      target,
      prepared,
      opts,
      timeoutMs: updateStepTimeoutMs,
      invocationCwd,
      presentation,
      stagedPackage: initialization?.stagedPackage,
      candidateAdmission: initialization?.candidateAdmission,
    },
    (stagedPackage) =>
      runResolvedUpdate(
        opts,
        recoveryState,
        invocationCwd,
        prepared,
        presentation,
        executor,
        retainRuntime,
        target,
        stagedPackage,
        initialization,
      ),
  );
}

async function runResolvedUpdate(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  prepared: PreparedUpdate,
  presentation: ReturnType<typeof createUpdateProgress>,
  executor: UpdateCommandExecutor,
  retainRuntime: RetainUpdateRuntime,
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>,
  stagedPackage?: StagedPackageInstallUpdate,
  initialization?: InitializedUpdate,
): Promise<void> {
  const {
    startedAt,
    timeoutMs,
    shouldRestart,
    requestedChannel,
    controlPlaneUpdateSentinelMeta,
    discoveredRoot,
    installKind,
  } = prepared;
  const run = opts.run!;
  const updateStepTimeoutMs =
    timeoutMs ?? run.defaultStepTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const {
    root,
    mode,
    updateInstallKind,
    configSnapshot,
    legacyConfigPlan,
    storedChannel,
    channel,
    switchToGit,
    switchToPackage,
    tag,
    currentVersion,
    targetVersion,
    downgradeRisk,
    packageInstallTarget,
    packageAlreadyCurrent,
    packageRuntimeTarget,
    managedServiceRootRedirect,
    managedServiceRoot,
    managedServiceNodeRunner,
  } = target;
  let { packageUpdateNodeRunner } = target;
  const refuseUpdate: typeof target.refuseUpdate = async (
    reason,
    message,
    failureFacts,
    recoverySteps,
  ) => {
    await stagedPackage?.close();
    return await reportPreMutationUpdateResult({
      root,
      mode,
      installKind: updateInstallKind,
      opts,
      controlPlaneUpdateSentinelMeta,
      reason,
      message,
      failureFacts,
      recoverySteps,
    });
  };

  recordUpdateRunPhase(
    run.runId,
    "staging",
    {
      target: {
        channel,
        tag,
        kind: updateInstallKind,
        ...(targetVersion ? { version: targetVersion } : {}),
      },
      before: { version: currentVersion ?? VERSION },
    },
    { env: run.env },
  );
  if (
    opts.channel &&
    !configSnapshot.valid &&
    !legacyConfigPlan &&
    !run.candidateAdmissionChecks?.includes("config")
  ) {
    const failure = createUpdateConfigFailure(configSnapshot);
    return await refuseUpdate(failure.reason, failure.message, failure.failureFacts);
  }
  const schemaPreflight = await preflightUpdateCommandSchemas({
    ...target,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    packageTargetVersion: targetVersion ?? undefined,
    opts,
    refuseUpdate,
  });
  if (!schemaPreflight) {
    return;
  }

  if (opts.dryRun) {
    finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, { env: run.env });
    return await previewUpdateCommand({
      target,
      prepared,
      opts,
      runId: run.runId,
      updateStepTimeoutMs,
      invocationCwd,
      preflight: schemaPreflight,
    });
  }

  const currentCoreFinalization = {
    opts,
    legacyConfigPlan,
    root,
    previousInstallRoot: discoveredRoot,
    requestedChannel,
    storedChannel,
    channel,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    startedAt,
    controlPlaneUpdateSentinelMeta,
    packageUpdateNodeRunner: packageUpdateNodeRunner ?? managedServiceNodeRunner,
    runtimeTarget: packageRuntimeTarget,
    managedServiceRootRedirect,
    managedServiceRoot,
    stop: presentation.stop,
    refuseUpdate,
  };
  const pluginCount = Object.keys(configSnapshot.config.plugins?.entries ?? {}).length;
  const activateCurrentCore = async () => {
    run.executorFence = await executor.enter(root, {
      preflight: true,
      serviceRoot: managedServiceRoot,
      activationTimeoutMs: (run.activationTimeoutMs ??=
        timeoutMs === undefined
          ? undefined
          : await resolveUpdateFinalizationTimeoutMs(updateStepTimeoutMs, {
              env: run.env,
              pluginCount,
            })),
    });
    run.executorFence.assertCurrent();
    assertUpdatePackageActivationAdmission(root, { serviceRoot: managedServiceRoot });
  };
  if (packageAlreadyCurrent) {
    await activateCurrentCore();
    const { finishAlreadyCurrentUpdate } = await import("./update-execution.runtime.js");
    return await finishAlreadyCurrentUpdate({
      ...currentCoreFinalization,
      result: {
        status: "skipped",
        mode: packageInstallTarget?.manager ?? "unknown",
        root,
        reason: "already-current",
        before: { version: currentVersion },
        after: { version: currentVersion },
        steps: [],
        durationMs: Date.now() - startedAt,
      },
    });
  }

  if (
    downgradeRisk &&
    !opts.yes &&
    !initialization?.downgradeConfirmed &&
    !(await confirmUpdateDowngrade({ opts, currentVersion, targetVersion, tag }))
  ) {
    return;
  }

  if (updateInstallKind === "git" && opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (updateInstallKind === "package") {
    const runtimePreflight = await preparePackageUpdateRuntime({
      ...target,
      managedService: schemaPreflight.service,
      shouldRestart,
      opts,
      executor,
      timeoutMs: updateStepTimeoutMs,
    });
    if (!runtimePreflight.ok) {
      return await refuseUpdate(
        "node-runtime-preflight",
        runtimePreflight.error,
        runtimePreflight.failureFacts,
        runtimePreflight.recoverySteps,
      );
    }
    packageUpdateNodeRunner = runtimePreflight.value.nodeRunner;
    recoveryState.triageTarget.nodeRunner = packageUpdateNodeRunner;
  }

  // Preload execution and recovery before the package swap can remove these chunks.
  const {
    executeMutableUpdate,
    finishUpdate,
    finishAlreadyCurrentUpdate,
    continueMigratedUpdateInFreshProcess,
    inspectActivatedUpdateState,
    restoreFailedUpdateDatabases,
    createUpdateCommandFinalizationFence,
  } = await import("./update-execution.runtime.js");

  const progress = createUpdateRunProgress(run, presentation.progress);
  let preUpdatePluginInstallRecords: Awaited<ReturnType<typeof prepareMutableUpdateRuntime>> = {};
  let mutableUpdatePrepared = false;
  const prepareMutableUpdate: Parameters<
    typeof executeMutableUpdate
  >[0]["prepareMutableUpdate"] = async (env, activationTimeoutMs, admitExecutor, installTarget) => {
    if (!mutableUpdatePrepared) {
      assertUpdatePackageActivationAdmission(root, { serviceRoot: managedServiceRoot });
    }
    const fence = await executor.enter(root, {
      serviceRoot: managedServiceRoot,
      activationTimeoutMs,
    });
    admitExecutor(fence);
    run.activationTimeoutMs ??= activationTimeoutMs;
    fence.assertCurrent();
    if (mutableUpdatePrepared) {
      if (managedServiceRoot) {
        assertUpdatePackageActivationAdmission(managedServiceRoot);
      }
      return;
    }
    const installKey = captureUpdateCommandExecutorAuthority(fence).installKey;
    assertUpdatePackageActivationAdmission(installKey, { serviceRoot: managedServiceRoot });
    preUpdatePluginInstallRecords = await prepareMutableUpdateRuntime(env, fence);
    // Retention can walk the full dependency tree before the first staging step.
    // Record that work so the completed capacity check does not look stalled.
    const retentionStep = {
      name: "updater-runtime-retention",
      command: "retain running updater runtime",
      index: 0,
      total: 0,
    };
    const retentionStartedAt = Date.now();
    progress.onStepStart?.(retentionStep);
    const retention = await retainRuntime({
      mutationRoots: [root, ...(switchToGit ? [resolveGitInstallDir()] : [])],
      installTarget,
      env,
      timeoutMs: updateStepTimeoutMs,
      assertCurrent: () => fence.assertCurrent(),
    });
    progress.onStepComplete?.({
      ...retentionStep,
      durationMs: Date.now() - retentionStartedAt,
      exitCode: 0,
      diagnostics: retention ? [JSON.stringify(retention)] : undefined,
    });
    mutableUpdatePrepared = true;
  };

  const execution = await executeMutableUpdate({
    ...target,
    installKind,
    timeoutMs,
    updateStepTimeoutMs,
    startedAt,
    progress,
    stop: presentation.stop,
    opts,
    shouldRestart,
    stagedPackage,
    packageTargetVersion: targetVersion ?? undefined,
    packageUpdateNodeRunner,
    managedServiceNodeRunner,
    managedServiceRootRedirect,
    managedServiceRoot,
    invocationCwd,
    recoveryState,
    prepareMutableUpdate,
    onActivation: () => {
      presentation.suspend();
      progress.deferLedgerWrites();
    },
  });
  run.executorFence?.assertCurrent();
  if (!execution) {
    return;
  }
  const { ownedManagedUpdateContext, recoveryEnv, ...executionState } = execution;
  const { result } = executionState;
  result.runId = run.runId;
  if (result.status === "skipped" && result.reason === "already-current") {
    await activateCurrentCore();
    presentation.stop();
    return await finishAlreadyCurrentUpdate({
      ...currentCoreFinalization,
      root: result.root ?? root,
      result,
      ownedManagedUpdateEnv: ownedManagedUpdateContext?.env,
      packageUpdateNodeRunner: packageUpdateNodeRunner ?? managedServiceNodeRunner,
    });
  }
  recoveryState.triageTarget.root = result.root ?? root;
  recoveryState.triageTarget.failureResult = result;
  recoveryState.triageTarget.env =
    recoveryEnv ?? ownedManagedUpdateContext?.env ?? recoveryState.triageTarget.env;
  presentation.stop();
  const finalization = {
    ...executionState,
    expectedVersion: targetVersion ?? undefined,
    root,
    previousInstallRoot: discoveredRoot,
    installKindChanged: switchToGit || switchToPackage,
    configSnapshot: ownedManagedUpdateContext?.configSnapshot ?? configSnapshot,
    requestedChannel,
    storedChannel,
    channel,
    downgradeRisk,
    shouldRestart,
    opts,
    ownedManagedUpdateEnv: ownedManagedUpdateContext?.env,
    controlPlaneUpdateSentinelMeta,
    preUpdatePluginInstallRecords:
      ownedManagedUpdateContext?.pluginInstallRecords ?? preUpdatePluginInstallRecords,
    startedAt,
    packageUpdateNodeRunner,
    updateStepTimeoutMs,
    invocationCwd,
  };
  const rollbackBlockedReason = opts.recovery
    ? undefined
    : await inspectActivatedUpdateState({
        result,
        root,
        packageUpdateNodeRunner,
        schemaVersions: execution.schemaVersions,
        candidateSchemaVersions: execution.candidateSchemaVersions,
        config: finalization.configSnapshot.config,
        env: ownedManagedUpdateContext?.env ?? run.env,
        timeoutMs: updateStepTimeoutMs,
      });
  run.executorFence?.assertCurrent();
  if (opts.recovery || rollbackBlockedReason) {
    // Only candidate code may reopen migrated state, including during reporting and cleanup.
    recoveryState.ledgerHandoffOwned = true;
    const assertRollbackCurrent = createUpdateCommandFinalizationFence(finalization);
    const continued = await continueMigratedUpdateInFreshProcess(
      { ...finalization, rollbackBlockedReason },
      progress.pendingSteps,
    );
    if (continued.databaseRollbackAvailable && finalization.databaseBackup) {
      const restored = await restoreFailedUpdateDatabases({
        backup: finalization.databaseBackup,
        result: continued.result,
        runId: run.runId,
        env: ownedManagedUpdateContext?.env ?? run.env,
        assertCurrent: assertRollbackCurrent,
        progress,
      });
      if (!restored) {
        throw new UpdateCommandPendingRecoveryFailure(
          continued.result,
          continued.result.steps.at(-1)?.stderrTail ?? undefined,
        );
      }
      progress.flushLedgerWrites();
      recoveryState.ledgerHandoffOwned = false;
      presentation.resume();
      await finishUpdate({ ...finalization, result: continued.result });
      return;
    }
    recoveryState.ledgerHandoffCompleted = true;
    opts.onResult?.(continued.result);
    if (continued.exitCode !== 0) {
      throw new UpdateCommandFailure(continued.result, continued.exitCode, undefined, {
        automaticTriage: continued.automaticTriage,
      });
    }
    return;
  }
  progress.flushLedgerWrites();
  presentation.resume();
  await finishUpdate(finalization);
}
