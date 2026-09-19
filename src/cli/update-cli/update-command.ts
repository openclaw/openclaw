import { randomUUID } from "node:crypto";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../version.js";
import { createUpdateProgress, type UpdateDisplayProgress } from "./progress.js";
import {
  confirmUpdateDowngrade,
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
  prepareUpdateCommand,
  prepareMutableUpdateRuntime,
  resolveUpdateCommandAdmissionEnv,
  withUpdatePreviewSignals,
} from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import {
  resolveServiceRefreshEnv,
  withOwnedManagedUpdateEnv,
  resolveUpdateTargetEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { resolveFreshUpdateMetadata, resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportPreMutationUpdateResult,
  prepareUnexpectedUpdateCommandFailure,
  reportUnreportedUpdateAdmissionOutcome,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import {
  prepareUpdateCommandFailureTriage,
  withUpdateFailureTriage,
} from "./update-command-triage.js";
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
    const env = await resolveUpdateCommandAdmissionEnv({
      opts: inputOpts,
      root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
      invocationCwd,
      pkgOwnership: prepared.pkgOwnership,
    });
    const { updateStateNeedsInitialization } = await import("./update-command-initialization.js");
    if (await updateStateNeedsInitialization(env)) {
      return await initializeAndRunUpdate(inputOpts, prepared, recoveryState, invocationCwd, env);
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
      throw await prepareUnexpectedUpdateCommandFailure(error, opts);
    }
    throw error;
  } finally {
    disposePresentation?.();
  }
}

async function initializeAndRunUpdate(
  opts: UpdateCommandOptions,
  prepared: PreparedUpdate,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const targetEnv = resolveUpdateTargetEnv({ baseEnv: env, nodeRunner: process.execPath });
  const runId = env.OPENCLAW_UPDATE_RUN_ID?.trim() || randomUUID();
  let handleFailure: Awaited<ReturnType<typeof prepareUpdateCommandFailureTriage>> | undefined;
  try {
    await withUpdateCommandTerminalResult(
      (registerRun) =>
        withUpdateInProgressEnv(invocationCwd, () =>
          withUpdateCommandExecutor(runId, async (executor) => {
            const target = await withOwnedManagedUpdateEnv(targetEnv, () =>
              resolveUpdateCommandTarget(
                opts,
                recoveryState,
                invocationCwd,
                prepared,
                executor,
                prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
              ),
            );
            if (!target) {
              return;
            }
            const initialization: InitializedUpdate = {
              env,
              runId,
              executor,
              registerRun: async (run) => {
                registerRun(run);
                handleFailure = await prepareUpdateCommandFailureTriage(
                  { ...opts, invocationCwd, run },
                  recoveryState.triageTarget,
                );
              },
              target,
              databasePath: resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)),
              configPath: resolvePathViaExistingAncestorSync(resolveConfigPath(env)),
            };
            const runInitialized = () =>
              runAdmittedUpdate(opts, prepared, recoveryState, invocationCwd, initialization);
            if (opts.dryRun) {
              return await previewUpdateCommand({
                target,
                prepared,
                opts,
                runId,
                invocationCwd,
                updateStepTimeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
              });
            }
            const artifact =
              target.updateInstallKind === "package" &&
              !canResolveRegistryVersionForPackageTarget(target.packageInstallSpec ?? target.tag);
            const stageParams = (progress: UpdateDisplayProgress) => ({
              reapplyLocalOverrides: opts.reapplyLocalOverrides,
              root: target.root,
              installKind: prepared.installKind,
              tag: target.tag,
              installSpec: target.packageInstallSpec ?? undefined,
              timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
              startedAt: prepared.startedAt,
              progress,
              managedServiceEnv: env,
              invocationCwd,
              honorPackageRoot:
                target.managedServiceRootRedirect !== null ||
                target.managedServiceNodeRunner !== undefined,
              nodeRunner: target.packageUpdateNodeRunner,
              installEnv: resolveUpdateTargetEnv({
                baseEnv: target.packageInstallEnv,
                serviceEnv: env,
                invocationCwd,
              }),
              installTarget: target.packageInstallTarget,
            });
            const runSelectedTarget = async () => {
              if (target.updateInstallKind !== "package") {
                return await runInitialized();
              }
              const metadata = await resolveFreshUpdateMetadata(target);
              if (!metadata) {
                return;
              }
              const { version: targetVersion, schemaVersions: schemas } = metadata;
              if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION && !artifact) {
                return await runInitialized();
              }
              const timeoutMs = prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
              const selectedStoredChannel = target.storedChannel;
              const checkSchemas = async () => {
                const { readUpdateChannelConfig } = await import("./update-command-config.js");
                const config = await withOwnedManagedUpdateEnv(env, () =>
                  readUpdateChannelConfig(Boolean(opts.channel)),
                );
                if (!opts.channel && config.storedChannel !== selectedStoredChannel) {
                  await target.refuseUpdate(
                    "update-channel-changed",
                    "Stored update channel changed after target selection. Rerun the update, or specify --channel explicitly.",
                  );
                }
                Object.assign(target, config);
                return await preflightUpdateCommandSchemas({
                  ...target,
                  shouldRestart: prepared.shouldRestart,
                  updateStepTimeoutMs: timeoutMs,
                  invocationCwd,
                  packageTargetVersion: target.targetVersion ?? undefined,
                  opts,
                });
              };
              const schemaPreflight = await checkSchemas();
              const initializationRuntime = await import("./update-command-initialization.js");
              await initializationRuntime.confirmFreshUpdateDowngrade({
                target,
                opts,
                controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
              });
              initialization.downgradeConfirmed = true;
              const runtime = await resolvePackageRuntimePreflight({
                ...target,
                shouldRestart: prepared.shouldRestart,
                target: target.packageRuntimeTarget,
                timeoutMs,
                nodeRunner: target.managedServiceNodeRunner,
                service: schemaPreflight?.service,
                invocationCwd,
              });
              if (!runtime.ok) {
                return await target.refuseUpdate(
                  "node-runtime-preflight",
                  runtime.error,
                  runtime.failureFacts,
                  runtime.recoverySteps,
                );
              }
              target.packageUpdateNodeRunner = runtime.value.nodeRunner;
              if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION) {
                return await runInitialized();
              }
              const fence = await executor.enter(target.root, { preflight: true });
              fence.assertCurrent();
              const { stagePackageInstallUpdate } = await import("./update-command-package.js");
              const legacyFence = initializationRuntime.acquireLegacyUpdateInitializationFence({
                env,
                targetVersion,
                targetSchemas: schemas,
              });
              await initializationRuntime.withUpdateInitializationCleanup(
                async () => {
                  await initializationRuntime.withUpdateInitializationCleanup(
                    async () => {
                      const presentation = createUpdateProgress(!opts.json);
                      try {
                        await checkSchemas();
                        fence.assertCurrent();
                        if (!target.packageAlreadyCurrent && !initialization.stagedPackage) {
                          initialization.stagedPackage = await stagePackageInstallUpdate(
                            stageParams(presentation.progress),
                          );
                        }
                        fence.assertCurrent();
                        await initializationRuntime.initializeUpdateStateFromTarget({
                          root: initialization.stagedPackage?.root ?? target.root,
                          env,
                          timeoutMs,
                          nodeRunner: target.packageUpdateNodeRunner,
                          invocationCwd,
                          progress: presentation.progress,
                          assertCurrent: fence.assertCurrent,
                          checkSchemas: async () => void (await checkSchemas()),
                        });
                      } finally {
                        presentation.dispose();
                      }
                    },
                    () => legacyFence?.release(),
                  );
                  await runInitialized();
                },
                () => (artifact ? undefined : initialization.stagedPackage?.close()),
              );
            };
            if (!artifact) {
              return await runSelectedTarget();
            }
            const { runFreshUpdateArtifact } = await import("./update-command-artifact.js");
            return await runFreshUpdateArtifact(
              { initialization, stageParams, json: Boolean(opts.json) },
              runSelectedTarget,
            );
          }),
        ),
      opts,
    );
  } catch (error) {
    if (!handleFailure) {
      return await reportUnreportedUpdateAdmissionOutcome(error);
    }
    // The admitted run's prepared handler outlives both staged cleanup and the
    // executor, so no failure is reported while either mutation owner remains live.
    await handleFailure(error);
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
    packageInstallSpec,
    packageInstallTarget,
    packageAlreadyCurrent,
    packageRuntimeTarget,
    managedServiceRootRedirect,
    managedServiceNodeRunner,
  } = target;
  let { packageUpdateNodeRunner } = target;
  const refuseUpdate: typeof target.refuseUpdate = (reason, message, failureFacts, recoverySteps) =>
    reportPreMutationUpdateResult({
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
      ...target,
      shouldRestart,
      target: packageRuntimeTarget,
      timeoutMs: updateStepTimeoutMs,
      nodeRunner: managedServiceNodeRunner,
      service: schemaPreflight.service,
      invocationCwd,
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
    if (runtimePreflight.value.replacedNodeRunner && !opts.json) {
      defaultRuntime.log(
        theme.warn(
          `Managed gateway service Node (${runtimePreflight.value.replacedNodeRunner}) cannot run openclaw@${runtimePreflight.value.targetVersion ?? tag}.`,
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
    if (mutableUpdatePrepared) {
      return;
    }
    assertUpdatePackageActivationAdmission(captureUpdateCommandExecutorAuthority(fence).installKey);
    preUpdatePluginInstallRecords = await prepareMutableUpdateRuntime(env, fence);
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
    stagedPackage: initialization?.stagedPackage,
    packageTargetVersion: targetVersion ?? undefined,
    packageUpdateNodeRunner,
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
