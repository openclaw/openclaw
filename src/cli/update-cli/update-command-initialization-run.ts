import { randomUUID } from "node:crypto";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveDebugProxySettings } from "../../proxy-capture/env.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateProgress } from "./progress.js";
import {
  UpdatePreMutationError,
  usesCandidateUpdateAdmission,
  type UpdateCommandOptions,
} from "./shared.js";
import { withPrivateStagedPackageInstall } from "./update-command-artifact.js";
import {
  applyUpdateCandidateAdmission,
  assertUpdateAdmissionConfigUnchanged,
  inspectStagedUpdateCandidateAdmission,
} from "./update-command-candidate-admission.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import type { UpdateCommandExecutorOptions } from "./update-command-executor-options.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import {
  acquireLegacyUpdateInitializationFence,
  confirmFreshUpdateDowngrade,
  initializeUpdateStateFromTarget,
  withUpdateInitializationCleanup,
  type InitializedUpdate,
  type UpdateTargetSelection,
} from "./update-command-initialization.js";
import { preparePackageUpdateRuntime } from "./update-command-node-runtime.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import {
  assertUpdatePackageActivationAdmission,
  recordUpdateCommandTarget,
  type prepareUpdateCommand,
} from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import {
  resolveUpdateTargetEnv,
  withOwnedManagedUpdateEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import { resolveFreshUpdateMetadata, resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportUnreportedUpdateAdmissionOutcome,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { prepareUpdateCommandFailureTriage } from "./update-command-triage.js";

export async function initializeAndRunUpdate(
  opts: UpdateCommandOptions,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  env: NodeJS.ProcessEnv,
  runInitialized: (initialization: InitializedUpdate) => Promise<void>,
  policy: { needsInitialization: boolean; captureOriginal: boolean },
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  const targetEnv = resolveUpdateTargetEnv({ baseEnv: env, nodeRunner: process.execPath });
  const runId = env.OPENCLAW_UPDATE_RUN_ID?.trim() || randomUUID();
  let handleFailure: Awaited<ReturnType<typeof prepareUpdateCommandFailureTriage>> | undefined;
  let disposePresentation: (() => void) | undefined;
  try {
    await withUpdateCommandTerminalResult(
      (registerRun) =>
        withUpdateInProgressEnv(invocationCwd, () =>
          withUpdateCommandExecutor(
            runId,
            async (executor) => {
              const selection: UpdateTargetSelection | undefined = await withOwnedManagedUpdateEnv(
                targetEnv,
                () =>
                  resolveUpdateCommandTarget(
                    opts,
                    recoveryState,
                    invocationCwd,
                    prepared,
                    executor,
                    prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                  ),
              ).then(
                (target) => (target ? { target } : undefined),
                (error: unknown) => {
                  if (
                    policy.needsInitialization ||
                    hasCommandProcessCleanupError(error) ||
                    !(error instanceof UnreportedUpdateAdmissionOutcome)
                  ) {
                    throw error;
                  }
                  return { refusal: error };
                },
              );
              if (!selection) {
                return;
              }
              const selectedTarget = selection.target;
              const candidateAdmissionEnabled =
                selectedTarget?.updateInstallKind === "package" &&
                usesCandidateUpdateAdmission(opts, prepared.installKind);
              // Candidate execution stays in the selected profile; only installed union checks
              // can need a separate caller projection.
              const callerLegacyConfigPlan =
                selectedTarget &&
                !selectedTarget.managedServiceRootRedirect &&
                !candidateAdmissionEnabled &&
                opts.channel &&
                resolveConfigPath(env) !== resolveConfigPath()
                  ? (await readUpdateChannelConfig(true)).legacyConfigPlan
                  : undefined;
              const root = selection.refusal
                ? selection.refusal.report.root
                : selection.target.root;
              const packageAdmission = {
                serviceRoot: selection.refusal
                  ? selection.refusal.report.serviceRoot
                  : selection.target.managedServiceRoot,
              };
              const originalCaptureWarnings: string[] = [];
              const initialization: InitializedUpdate = {
                ...selection,
                env,
                runId,
                executor,
                callerLegacyConfigPlan,
                registerRun: async (run, dispose) => {
                  registerRun(run);
                  disposePresentation = dispose;
                  for (const result of selectedTarget?.preflightSteps ?? []) {
                    for (const step of updateRunStepsFromResultStep(result)) {
                      recordUpdateCommandTarget(run, { step });
                    }
                  }
                  if (selectedTarget?.inspectionWarning) {
                    recordUpdateCommandTarget(run, {
                      step: {
                        step: "warning:installation-inspection",
                        status: "completed",
                        detail: selectedTarget.inspectionWarning,
                      },
                    });
                  }
                  if (initialization.originalRecoveryCapture) {
                    recordUpdateCommandTarget(run, {
                      step: {
                        step: "original-state-capture",
                        status: "completed",
                        detail: `Original state retained for manual recovery at ${initialization.originalRecoveryCapture.directory}.`,
                      },
                    });
                  }
                  for (const [index, detail] of originalCaptureWarnings.entries()) {
                    recordUpdateCommandTarget(run, {
                      step: {
                        step: `warning:original-state-capture:${index + 1}`,
                        status: "completed",
                        detail,
                      },
                    });
                  }
                  handleFailure = await prepareUpdateCommandFailureTriage(
                    { ...opts, invocationCwd, run },
                    recoveryState.triageTarget,
                  );
                },
                databasePath: resolvePathViaExistingAncestorSync(
                  resolveOpenClawStateSqlitePath(env),
                ),
                configPath: resolvePathViaExistingAncestorSync(resolveConfigPath(env)),
              };
              let originalCaptureAttempted = false;
              const captureOriginal = async () => {
                if (!policy.captureOriginal || originalCaptureAttempted) {
                  return;
                }
                if (selectedTarget?.downgradeRisk && !initialization.downgradeConfirmed) {
                  await confirmFreshUpdateDowngrade({
                    target: selectedTarget,
                    opts,
                    controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
                  });
                  initialization.downgradeConfirmed = true;
                }
                const fence = await executor.enter(root, {
                  preflight: true,
                  ...packageAdmission,
                });
                const authority = captureUpdateCommandExecutorAuthority(fence, runId);
                const assertCurrent = () => {
                  fence.assertCurrent();
                  assertUpdatePackageActivationAdmission(root, packageAdmission);
                };
                const warn = (message: string) => {
                  const detail = redactSupportString(
                    message,
                    { env, stateDir: resolveStateDir(env) },
                    { maxLength: 1000 },
                  );
                  originalCaptureWarnings.push(detail);
                  defaultRuntime.error(`Warning: ${detail}`);
                };
                originalCaptureAttempted = true;
                try {
                  const { captureUpdateRecoveryBaseline } =
                    await import("../../infra/update-recovery-baseline-capture.js");
                  assertCurrent();
                  const driver = readUpdateRunDriver();
                  if (!driver) {
                    throw new Error("The original update process identity is unavailable.");
                  }
                  const captured = await captureUpdateRecoveryBaseline({
                    runId,
                    installRoot: authority.installKey,
                    env,
                    drivers: [driver],
                    assertCurrent,
                    nodeRunner: selectedTarget?.packageUpdateNodeRunner,
                    timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                  });
                  assertCurrent();
                  initialization.originalRecoveryCapture = captured.ref;
                  for (const message of [
                    ...captured.warnings.map((warning) => warning.message),
                    ...captured.diagnostics.databaseWarnings,
                  ].slice(0, 32)) {
                    warn(message);
                  }
                } catch (error) {
                  assertCurrent();
                  if (hasCommandProcessCleanupError(error)) {
                    throw error;
                  }
                  warn(`Original state capture is unavailable: ${formatErrorMessage(error)}`);
                }
                assertCurrent();
                if (resolveDebugProxySettings(env).enabled) {
                  warn(
                    "Debug HTTP capture is disabled in this updater process. Doctor may enable capture in its own process after schema readiness is confirmed.",
                  );
                }
              };
              const runCapturedInitialization = async () => {
                await captureOriginal();
                await runInitialized(initialization);
              };
              if (initialization.refusal) {
                return await runCapturedInitialization();
              }
              const target = initialization.target;
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
              const stageParams = (presentation: ReturnType<typeof createUpdateProgress>) => ({
                reapplyLocalOverrides: opts.reapplyLocalOverrides,
                root: target.root,
                installKind: prepared.installKind,
                tag: target.tag,
                installSpec: target.packageInstallSpec ?? undefined,
                timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                workTimeoutMs: prepared.timeoutMs ?? null,
                startedAt: prepared.startedAt,
                progress: presentation.progress,
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
                requirePackageReplacement: target.managedServiceRoot !== undefined,
                ...(candidateAdmissionEnabled
                  ? {
                      resolveLifecycleNodeRunner: () => target.packageUpdateNodeRunner,
                      beforeVerifyCandidate: async (candidateRoot: string) => {
                        const fence = await executor.enter(target.root, {
                          preflight: true,
                          serviceRoot: target.managedServiceRoot,
                        });
                        const assertCurrent = () => {
                          fence.assertCurrent();
                          assertUpdatePackageActivationAdmission(target.root, packageAdmission);
                        };
                        try {
                          initialization.candidateAdmission =
                            await inspectStagedUpdateCandidateAdmission({
                              target,
                              prepared,
                              opts,
                              timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                              invocationCwd,
                              presentation,
                              candidateRoot,
                              runId,
                              env,
                              assertCurrent,
                            });
                          applyUpdateCandidateAdmission({
                            target,
                            opts,
                            result: initialization.candidateAdmission.result,
                          });
                        } catch (error) {
                          if (!(error instanceof UpdatePreMutationError)) {
                            throw error;
                          }
                          throw new UnreportedUpdateAdmissionOutcome({
                            root: target.root,
                            mode: target.mode,
                            installKind: target.updateInstallKind,
                            opts,
                            controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
                            reason: error.reason,
                            message: error.message,
                            nextAction: error.nextAction,
                            failureFacts: error.failureFacts,
                            stepResult: error.stepResult,
                            recoverySteps: error.recoverySteps,
                          });
                        }
                      },
                    }
                  : {}),
              });
              const runSelectedTarget = async () => {
                assertUpdatePackageActivationAdmission(target.root, packageAdmission);
                if (target.updateInstallKind !== "package") {
                  return await runCapturedInitialization();
                }
                const metadata = await resolveFreshUpdateMetadata(target);
                if (!metadata) {
                  return;
                }
                const { version: targetVersion, schemaVersions: schemas } = metadata;
                if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION && !artifact) {
                  return await runCapturedInitialization();
                }
                const timeoutMs = prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
                const selectedStoredChannel = target.storedChannel;
                const candidateAdmissionChecks =
                  initialization.candidateAdmission?.result.verdict?.verdict === "admit"
                    ? initialization.candidateAdmission.result.verdict.facts.checks.map(
                        (check) => check.name,
                      )
                    : undefined;
                const checkSchemas = async (phase?: "before" | "after") => {
                  const config = await withOwnedManagedUpdateEnv(env, () =>
                    readUpdateChannelConfig(Boolean(opts.channel), {
                      tolerateReadFailure: candidateAdmissionChecks?.includes("config"),
                    }),
                  );
                  if (candidateAdmissionChecks?.includes("config") && phase !== "after") {
                    assertUpdateAdmissionConfigUnchanged(
                      target.configSnapshot,
                      config.configSnapshot,
                    );
                  }
                  if (!opts.channel && config.storedChannel !== selectedStoredChannel) {
                    await target.refuseUpdate(
                      "update-channel-changed",
                      "Stored update channel changed after target selection. Rerun the update, or specify --channel explicitly.",
                    );
                  }
                  Object.assign(target, config);
                  return await preflightUpdateCommandSchemas({
                    ...target,
                    callerLegacyConfigPlan,
                    shouldRestart: prepared.shouldRestart,
                    updateStepTimeoutMs: timeoutMs,
                    invocationCwd,
                    packageTargetVersion: target.targetVersion ?? undefined,
                    opts,
                    candidateAdmissionChecks,
                    expectedForeground:
                      prepared.controlPlaneUpdateSentinelMeta?.completionOwner ===
                        "gateway-restart" || undefined,
                  });
                };
                const schemaPreflight = await checkSchemas();
                if (!schemaPreflight) {
                  return;
                }
                await confirmFreshUpdateDowngrade({
                  target,
                  opts,
                  controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
                });
                initialization.downgradeConfirmed = true;
                await captureOriginal();
                const runtime = await preparePackageUpdateRuntime({
                  ...target,
                  managedService: schemaPreflight.service,
                  shouldRestart: prepared.shouldRestart,
                  opts,
                  executor,
                  timeoutMs,
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
                  return await runCapturedInitialization();
                }
                const fence = await executor.enter(target.root, {
                  preflight: true,
                  serviceRoot: target.managedServiceRoot,
                });
                const { stagePackageInstallUpdate } = await import("./update-command-package.js");
                fence.assertCurrent();
                assertUpdatePackageActivationAdmission(target.root, packageAdmission);
                const legacyFence = acquireLegacyUpdateInitializationFence({
                  env,
                  targetVersion,
                  targetSchemas: schemas,
                });
                let initializationStage: InitializedUpdate["stagedPackage"];
                const assertCurrent = () => {
                  fence.assertCurrent();
                  assertUpdatePackageActivationAdmission(target.root, packageAdmission);
                  legacyFence?.assertCurrent();
                };
                await withUpdateInitializationCleanup(
                  async () => {
                    const initialize = async () => {
                      const presentation = createUpdateProgress(!opts.json);
                      try {
                        await checkSchemas();
                        assertCurrent();
                        if (!target.packageAlreadyCurrent && !initialization.stagedPackage) {
                          initializationStage = await stagePackageInstallUpdate(
                            stageParams(presentation),
                          );
                          initialization.stagedPackage = initializationStage;
                        }
                        assertCurrent();
                        await initializeUpdateStateFromTarget({
                          root: initialization.stagedPackage?.root ?? target.root,
                          env,
                          timeoutMs,
                          workTimeoutMs: prepared.timeoutMs ?? null,
                          nodeRunner: target.packageUpdateNodeRunner,
                          invocationCwd,
                          progress: presentation.progress,
                          assertCurrent,
                          checkSchemas: async (phase) => void (await checkSchemas(phase)),
                        });
                      } finally {
                        presentation.dispose();
                      }
                    };
                    await withUpdateInitializationCleanup(
                      () => (legacyFence ? legacyFence.run(initialize) : initialize()),
                      () => legacyFence?.release(),
                    );
                    await runCapturedInitialization();
                  },
                  () => initializationStage?.close(),
                );
              };
              const runWithSelectedProfile = async () => {
                if (!policy.needsInitialization) {
                  return await runCapturedInitialization();
                }
                if (artifact) {
                  const { runFreshUpdateArtifact } = await import("./update-command-artifact.js");
                  return await runFreshUpdateArtifact(
                    { initialization, stageParams, json: Boolean(opts.json) },
                    runSelectedTarget,
                  );
                }
                if (
                  candidateAdmissionEnabled &&
                  target.packageTargetSchemaVersions &&
                  target.packageTargetSchemaVersions.state < OPENCLAW_STATE_SCHEMA_VERSION
                ) {
                  const presentation = createUpdateProgress(!opts.json);
                  try {
                    return await withPrivateStagedPackageInstall(
                      stageParams(presentation),
                      async ({ stage }) => {
                        initialization.stagedPackage = stage;
                        return await runSelectedTarget();
                      },
                    );
                  } finally {
                    presentation.dispose();
                  }
                }
                return await runSelectedTarget();
              };
              return candidateAdmissionEnabled
                ? await withOwnedManagedUpdateEnv(env, () =>
                    withUpdateInProgressEnv(invocationCwd, runWithSelectedProfile),
                  )
                : await runWithSelectedProfile();
            },
            executorOptions,
          ),
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
  } finally {
    // Terminal publication must flush the last committed phases before observation ends.
    disposePresentation?.();
  }
}
