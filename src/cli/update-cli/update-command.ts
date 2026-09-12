// Main update orchestration for source checkouts and package installs.
import { randomUUID } from "node:crypto";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveConfigPath } from "../../config/paths.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { createUpdateProgress } from "./progress.js";
import {
  confirmUpdateDowngrade,
  resolveNodeRunner,
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
import {
  gatewayServiceCommandUsesRoot,
  resolvePackageRuntimePreflight,
} from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportPreMutationUpdateResult,
  reportUnreportedUpdateAdmissionOutcome,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import {
  prepareUpdateCommandFailureTriage,
  withUpdateFailureTriage,
} from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

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
    const admission = {
      opts: inputOpts,
      root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
      invocationCwd,
      timeoutMs: prepared.timeoutMs,
    };
    const env = await resolveUpdateCommandAdmissionEnv(admission);
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
              }),
            ),
          );
    await withUpdatePreviewSignals(opts, execute);
  } catch (error) {
    // Execution owns its unwind, including helper-pending rollback and migrated state.
    // This boundary only terminalizes failures before that owner starts.
    if (!executionStarted) {
      failUpdateCommandRun(error, run);
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
  const runId = env.OPENCLAW_UPDATE_RUN_ID?.trim() || randomUUID();
  let handleFailure: Awaited<ReturnType<typeof prepareUpdateCommandFailureTriage>> | undefined;
  try {
    await withUpdateCommandTerminalResult((registerRun) =>
      withUpdateInProgressEnv(invocationCwd, () =>
        withUpdateCommandExecutor(runId, async (executor) => {
          const target = await withOwnedManagedUpdateEnv(env, () =>
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
          const stageParams = (progress: ReturnType<typeof createUpdateProgress>["progress"]) => ({
            root: target.root,
            installKind: prepared.installKind,
            tag: target.tag,
            installSpec: target.packageInstallSpec ?? undefined,
            timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
            startedAt: prepared.startedAt,
            progress,
            jsonMode: Boolean(opts.json),
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
            const schemas = target.packageTargetSchemaVersions;
            if (!target.targetVersion || !schemas) {
              return await target.refuseUpdate(
                "target-metadata-preflight",
                "The selected package could not be resolved to a published release with known database support. Retry with an exact published --tag before initializing this profile.",
              );
            }
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
              await preflightUpdateCommandSchemas({
                ...target,
                shouldRestart: prepared.shouldRestart,
                updateStepTimeoutMs: timeoutMs,
                invocationCwd,
                packageTargetVersion: target.targetVersion ?? undefined,
                opts,
              });
            };
            await checkSchemas();
            const initializationRuntime = await import("./update-command-initialization.js");
            await initializationRuntime.confirmFreshUpdateDowngrade({
              target,
              opts,
              controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
            });
            initialization.downgradeConfirmed = true;
            const canRefreshManagedServiceNode =
              prepared.shouldRestart &&
              target.managedServiceNodeRunner !== undefined &&
              (await gatewayServiceCommandUsesRoot({ root: target.root })) === true;
            const runtime = await resolvePackageRuntimePreflight({
              target: target.packageRuntimeTarget,
              timeoutMs,
              nodeRunner: target.managedServiceNodeRunner,
              fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
            });
            if (!runtime.ok) {
              return await target.refuseUpdate("node-runtime-preflight", runtime.error);
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
              targetVersion: target.targetVersion,
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
                        checkSchemas,
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
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const run = opts.run!;

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
  const refuseUpdate = (reason: string, message?: string) =>
    reportPreMutationUpdateResult({
      root,
      installKind: updateInstallKind,
      reason,
      message,
      opts,
      controlPlaneUpdateSentinelMeta,
    });

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
    legacyConfigPlan,
    root,
    updateInstallKind,
    switchToGit,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    managedServiceRootRedirect,
    channel,
    devTarget,
    packageTargetSchemaVersions,
    packageTargetVersion: targetVersion ?? undefined,
    packageInstallSpec,
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
    stop: presentation.stop,
    refuseUpdate,
  };
  if (packageAlreadyCurrent) {
    const { finishAlreadyCurrentUpdate } = await import("./update-execution.runtime.js");
    return await finishAlreadyCurrentUpdate({
      ...currentCoreFinalization,
      legacyConfigPlan,
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
    // Changing runners is safe only when this update owns and will rewrite the
    // service; otherwise the unchanged unit could still restart on the stale Node.
    const canRefreshManagedServiceNode =
      shouldRestart &&
      managedServiceNodeRunner !== undefined &&
      (await gatewayServiceCommandUsesRoot({ root })) === true;
    const runtimePreflight = await resolvePackageRuntimePreflight({
      target: packageRuntimeTarget,
      timeoutMs,
      nodeRunner: managedServiceNodeRunner,
      fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
    });
    if (!runtimePreflight.ok) {
      return await refuseUpdate("node-runtime-preflight", runtimePreflight.error);
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

  const { progress: displayProgress, stop } = presentation;
  const progress = createUpdateRunProgress(run, displayProgress);
  let preUpdatePluginInstallRecords: Awaited<
    ReturnType<typeof loadInstalledPluginIndexInstallRecords>
  > = {};
  let mutableUpdatePrepared = false;
  const prepareMutableUpdate = async (env?: NodeJS.ProcessEnv) => {
    if (!mutableUpdatePrepared) {
      assertUpdatePackageActivationAdmission(root);
    }
    const fence = await executor.enter(root);
    run.executorFence = fence;
    fence.assertCurrent();
    if (mutableUpdatePrepared) {
      return;
    }
    assertUpdatePackageActivationAdmission(captureUpdateCommandExecutorAuthority(fence).installKey);
    // Cleanup, state-write admission and updater autostart belong after complete target admission.
    await withOwnedManagedUpdateEnv(env, async () => {
      await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
      fence.assertCurrent();
      await assertOpenClawStateWriteAllowedAtPath({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
      });
      fence.assertCurrent();
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      fence.assertCurrent();
      preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
      fence.assertCurrent();
    });
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
    stop,
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
    stop();
    return await finishAlreadyCurrentUpdate({
      ...currentCoreFinalization,
      root: result.root ?? root,
      opts,
      result,
      ownedManagedUpdateEnv: ownedManagedUpdateContext?.env,
      packageUpdateNodeRunner: packageUpdateNodeRunner ?? managedServiceNodeRunner,
      legacyConfigPlan,
    });
  }
  recoveryState.triageTarget.root = result.root ?? root;
  recoveryState.triageTarget.failureResult = result;
  recoveryState.triageTarget.env =
    recoveryEnv ?? ownedManagedUpdateContext?.env ?? recoveryState.triageTarget.env;
  const finalizationConfigSnapshot = ownedManagedUpdateContext?.configSnapshot ?? configSnapshot;
  stop();
  const finalization = {
    ...executionState,
    expectedVersion: targetVersion ?? undefined,
    root,
    previousInstallRoot: discoveredRoot,
    installKindChanged: switchToGit || switchToPackage,
    configSnapshot: finalizationConfigSnapshot,
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
        config: finalizationConfigSnapshot.config,
        env: ownedManagedUpdateContext?.env ?? run.env,
      });
  run.executorFence?.assertCurrent();
  if (opts.recovery || rollbackBlockedReason) {
    // A migrated database belongs to the candidate runtime. The old process
    // must not reopen it, including during error reporting or outer cleanup.
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
