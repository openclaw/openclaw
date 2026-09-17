import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { createUpdateProgress } from "./progress.js";
import {
  confirmUpdateDowngrade,
  resolveGitInstallDir,
  tryResolveInvocationCwd,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  captureUpdateCommandExecutorAuthority,
  type UpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { InitializedUpdate } from "./update-command-initialization.js";
import { UpdateCommandFailure, withUpdateAdmissionReporting } from "./update-command-result.js";
import {
  admitUpdateCommandRun,
  assertUpdatePackageActivationAdmission,
  createUpdateRunProgress,
  failUpdateCommandRun,
  prepareUpdateCommand,
  prepareMutableUpdateRuntime,
  resolveUpdateCommandAdmissionEnv,
  withUpdatePreviewSignals,
} from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportPreMutationUpdateResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

type PreparedUpdate = NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>;

export async function updateCommand(inputOpts: UpdateCommandOptions): Promise<void> {
  const invocationCwd = tryResolveInvocationCwd();
  const recoveryState: UpdateCommandRecoveryState = {
    triageTarget: { env: resolveServiceRefreshEnv(process.env, invocationCwd) },
  };
  // Rejected arguments and handoffs must not open or recover persistent state.
  const prepared = await withUpdateAdmissionReporting(inputOpts, () =>
    withUpdateInProgressEnv(invocationCwd, () => prepareUpdateCommand(inputOpts)),
  );
  // Post-core children report phase results; the outer updater owns the run ledger.
  if (prepared.postCoreUpdateResume) {
    return await withUpdateInProgressEnv(invocationCwd, async () => {
      const { resumePostCoreUpdate } = await import("./update-execution.runtime.js");
      await resumePostCoreUpdate({
        root: prepared.discoveredRoot,
        channel: prepared.postCoreUpdateChannel,
        opts: inputOpts,
        timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      });
    });
  }
  return await withUpdateAdmissionReporting(inputOpts, async () => {
    const env = await resolveUpdateCommandAdmissionEnv({
      opts: inputOpts,
      root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
      invocationCwd,
      pkgOwnership: prepared.pkgOwnership,
      freebsdRootAdmission: prepared.freebsdRootAdmission,
    });
    const { updateStateNeedsInitialization } =
      await import("./update-command-state-initialization.js");
    if (await updateStateNeedsInitialization(env)) {
      const { initializeAndRunUpdate } = await import("./update-command-initialization.js");
      return await initializeAndRunUpdate({
        opts: inputOpts,
        prepared,
        recoveryState,
        invocationCwd,
        env,
        updateStepTimeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        runAdmitted: (initialization) =>
          runAdmittedUpdate(inputOpts, prepared, recoveryState, invocationCwd, initialization),
      });
    }
    return await runAdmittedUpdate(inputOpts, prepared, recoveryState, invocationCwd);
  });
}

async function runAdmittedUpdate(
  inputOpts: UpdateCommandOptions,
  prepared: PreparedUpdate,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  initialization?: InitializedUpdate,
): Promise<void> {
  const run = await admitUpdateCommandRun({
    opts: inputOpts,
    root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
    invocationCwd,
    initialization,
    pkgOwnership: prepared.pkgOwnership,
    freebsdRootAdmission: prepared.freebsdRootAdmission,
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
    await initialization?.registerRun(run);
    if (initialization?.target.updateInstallKind === "package") {
      run.executorFence = await initialization.executor.enter(initialization.target.root, {
        preflight: true,
      });
    }
    const presentation = createUpdateProgress(!opts.json, run);
    disposePresentation = presentation.dispose;
    const executeWith = (executor: UpdateCommandExecutor) => {
      executionStarted = true;
      return withUpdateCommandRecoveryUnwind(opts, recoveryState, () =>
        updateCommandInternal(
          opts,
          recoveryState,
          invocationCwd,
          prepared,
          presentation,
          executor,
          initialization,
        ),
      );
    };
    const execute = initialization
      ? () => executeWith(initialization.executor)
      : () =>
          withUpdateFailureTriage({ ...opts, invocationCwd }, recoveryState.triageTarget, () =>
            withUpdateInProgressEnv(invocationCwd, () =>
              withUpdateCommandTerminalResult((registerRun) => {
                registerRun(run);
                return withUpdateCommandExecutor(run.runId, executeWith);
              }, opts),
            ),
          );
    await withUpdatePreviewSignals(opts, execute);
  } catch (error) {
    // Execution owns recovery; only failures before execution starts are terminalized here.
    if (!executionStarted) {
      failUpdateCommandRun(error, run);
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
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  presentation: ReturnType<typeof createUpdateProgress>,
  executor: UpdateCommandExecutor,
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
  const {
    root,
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
    packageInstallSpec,
    packageInstallEnv,
    packageInstallTarget,
    packageAlreadyCurrent,
    packageTargetSchemaVersions,
    packageRuntimeTarget,
    managedServiceRootRedirect,
    managedServiceNodeRunner,
    devTarget,
  } = target;
  let { packageUpdateNodeRunner } = target;
  const reportContext = {
    root,
    installKind: updateInstallKind,
    opts,
    controlPlaneUpdateSentinelMeta,
  };
  const refuseUpdate: typeof target.refuseUpdate = (reason, message, failureFacts) =>
    reportPreMutationUpdateResult({ ...reportContext, reason, message, failureFacts });

  recordUpdateRunPhase(
    run.runId,
    "staging",
    {
      target: {
        channel,
        tag,
        ...(updateInstallKind !== "unknown" ? { kind: updateInstallKind } : {}),
        ...(targetVersion ? { version: targetVersion } : {}),
      },
      before: { version: currentVersion ?? VERSION },
    },
    { env: run.env },
  );
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
    packageInstallSpec,
    runtimeTarget: packageRuntimeTarget,
    managedServiceRootRedirect,
    stop: presentation.stop,
    refuseUpdate,
  };
  const pluginCount = Object.keys(configSnapshot.config.plugins?.entries ?? {}).length;
  const activateCurrentCore = async () => {
    run.executorFence = await executor.enter(root, {
      preflight: true,
      activationTimeoutMs: (run.activationTimeoutMs ??= await resolveUpdateFinalizationTimeoutMs(
        updateStepTimeoutMs,
        { env: run.env, pluginCount },
      )),
    });
    if (run.freebsdRootAdmission) {
      await run.freebsdRootAdmission.revalidate(
        { roots: [discoveredRoot, root], env: run.env, timeoutMs: updateStepTimeoutMs },
        run.executorFence.assertCurrent,
      );
    }
  };
  if (packageAlreadyCurrent) {
    await activateCurrentCore();
    const { finishAlreadyCurrentUpdate } = await import("./update-execution.runtime.js");
    return await finishAlreadyCurrentUpdate({
      ...currentCoreFinalization,
      opts,
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
    const runtimePreflight = await resolvePackageRuntimePreflight({
      root,
      shouldRestart,
      target: packageRuntimeTarget,
      timeoutMs: updateStepTimeoutMs,
      nodeRunner: managedServiceNodeRunner,
    });
    if (!runtimePreflight.ok) {
      const { error, failureFacts } = runtimePreflight;
      return await refuseUpdate("node-runtime-preflight", error, failureFacts);
    }
    const runtimeSelection = runtimePreflight.value;
    packageUpdateNodeRunner = runtimeSelection.nodeRunner;
    recoveryState.triageTarget.nodeRunner = packageUpdateNodeRunner;
    if (runtimeSelection.replacedNodeRunner && !opts.json) {
      defaultRuntime.log(
        theme.warn(
          `Managed gateway service Node (${runtimeSelection.replacedNodeRunner}) cannot run openclaw@${runtimeSelection.targetVersion ?? tag}.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Using current Node (${packageUpdateNodeRunner}) and refreshing the managed service runtime after the update.`,
        ),
      );
    }
  }

  // Preload execution and recovery before the package swap can remove these chunks.
  const {
    executeMutableUpdate,
    finishUpdate,
    finishAlreadyCurrentUpdate,
    continueMigratedUpdateInFreshProcess,
    inspectActivatedUpdateState,
  } = await import("./update-execution.runtime.js");

  const progress = createUpdateRunProgress(run, presentation.progress);
  let preUpdatePluginInstallRecords: Awaited<ReturnType<typeof prepareMutableUpdateRuntime>> = {};
  let mutableUpdatePrepared = false;
  const prepareMutableUpdate = async (env?: NodeJS.ProcessEnv, activationTimeoutMs?: number) => {
    if (!mutableUpdatePrepared) {
      assertUpdatePackageActivationAdmission(root);
    }
    const fence = await executor.enter(root, { activationTimeoutMs });
    run.executorFence = fence;
    run.activationTimeoutMs ??= activationTimeoutMs;
    fence.assertCurrent();
    if (run.freebsdRootAdmission) {
      await run.freebsdRootAdmission.revalidate(
        {
          roots: [
            discoveredRoot,
            root,
            ...(packageInstallTarget?.packageRoot ? [packageInstallTarget.packageRoot] : []),
            ...(switchToGit ? [resolveGitInstallDir()] : []),
          ],
          env: env ?? run.env,
          timeoutMs: updateStepTimeoutMs,
        },
        fence.assertCurrent,
      );
    }
    if (mutableUpdatePrepared) {
      return;
    }
    assertUpdatePackageActivationAdmission(captureUpdateCommandExecutorAuthority(fence).installKey);
    preUpdatePluginInstallRecords = await prepareMutableUpdateRuntime(
      env,
      run.freebsdRootAdmission
        ? {
            assertCurrent() {
              run.freebsdRootAdmission?.assertCurrent();
              fence.assertCurrent();
            },
          }
        : fence,
    );
    mutableUpdatePrepared = true;
  };

  const execution = await executeMutableUpdate({
    legacyConfigPlan,
    root,
    installKind,
    updateInstallKind,
    switchToGit,
    timeoutMs,
    updateStepTimeoutMs,
    startedAt,
    progress,
    stop: presentation.stop,
    channel,
    tag,
    opts,
    shouldRestart,
    devTarget,
    packageInstallSpec,
    packageInstallEnv,
    packageInstallTarget,
    stagedPackage: initialization?.stagedPackage,
    packageTargetSchemaVersions,
    packageTargetVersion: targetVersion ?? undefined,
    packageUpdateNodeRunner,
    managedServiceNodeRunner,
    managedServiceRootRedirect,
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
      opts,
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
    const continued = await continueMigratedUpdateInFreshProcess(
      { ...finalization, rollbackBlockedReason },
      progress.pendingSteps,
    );
    recoveryState.ledgerHandoffCompleted = true;
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
