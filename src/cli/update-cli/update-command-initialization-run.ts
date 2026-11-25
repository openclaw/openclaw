import { randomUUID } from "node:crypto";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatDiskSpaceBytes } from "../../infra/disk-space.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { findUpdateCaptureSpaceError } from "../../infra/update-capture-space.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveDebugProxySettings } from "../../proxy-capture/env.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { createUpdateProgress } from "./progress.js";
import {
  UpdatePreMutationError,
  usesCandidateUpdateAdmission,
  type UpdateCommandOptions,
} from "./shared.js";
import { reportUnreportedUpdateAdmissionOutcome } from "./update-command-admission-report.js";
import { withPrivateStagedPackageInstall } from "./update-command-artifact.js";
import {
  applyUpdateCandidateAdmission,
  createUpdateCandidateAdmissionReport,
  inspectStagedUpdateCandidateAdmission,
} from "./update-command-candidate-admission.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import type {
  UpdateCommandExecutor,
  UpdateCommandExecutorOptions,
} from "./update-command-executor-options.js";
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
import { assertUpdatePackageActivationAdmission } from "./update-command-package-activation.js";
import { withUpdatePreviewSignals } from "./update-command-preview-signals.js";
import { UnreportedUpdateAdmissionOutcome, type RefuseUpdate } from "./update-command-result.js";
import { recordUpdateCommandTarget, type prepareUpdateCommand } from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import {
  resolveServiceRefreshEnv,
  resolveUpdateTargetEnv,
  withOwnedManagedUpdateEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { prepareUpdateCommandFailureTriage } from "./update-command-triage.js";

/** A fresh profile must be initialized by an identified, schema-declaring target. */
async function resolveFreshUpdateMetadata(target: {
  targetVersion: string | null;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  refuseUpdate: RefuseUpdate;
}) {
  if (target.targetVersion && target.packageTargetSchemaVersions) {
    return { version: target.targetVersion, schemaVersions: target.packageTargetSchemaVersions };
  }
  const failure = createUpdatePreflightFailure(
    target.targetVersion ? "target-schema-metadata" : "target-registry-dist-tag",
  );
  await target.refuseUpdate("target-metadata-preflight", failure.message, failure.failureFacts);
  return undefined;
}

export async function initializeAndRunUpdate(
  opts: UpdateCommandOptions,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  env: NodeJS.ProcessEnv,
  runInitialized: (initialization: InitializedUpdate) => Promise<void>,
  policy: {
    needsInitialization: boolean;
    captureOriginal: boolean;
    malformedConfig?: ConfigFileSnapshot;
  },
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  // Repair uses the invoking operator, even when run registration enters the service environment.
  const operatorEnv = resolveServiceRefreshEnv(process.env, invocationCwd);
  const targetEnv = resolveUpdateTargetEnv({ baseEnv: env, nodeRunner: process.execPath });
  const runId = env.OPENCLAW_UPDATE_RUN_ID?.trim() || randomUUID();
  let handleFailure: Awaited<ReturnType<typeof prepareUpdateCommandFailureTriage>> | undefined;
  let disposePresentation: (() => void) | undefined;
  let admissionAttempted = false;
  try {
    await withUpdateCommandTerminalResult(
      (registerRun) =>
        withUpdateInProgressEnv(invocationCwd, () =>
          withUpdateCommandExecutor(
            runId,
            async (originalExecutor) => {
              const executor: UpdateCommandExecutor = {
                enter: (...args) => {
                  // enter can acquire ownership before failing. Once attempted, an
                  // unregistered refusal cannot borrow shared state after settlement.
                  admissionAttempted = true;
                  return originalExecutor.enter(...args);
                },
                exclude: originalExecutor.exclude?.bind(originalExecutor),
              };
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
                    policy.malformedConfig,
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
                !policy.malformedConfig &&
                selectedTarget &&
                !selectedTarget.managedServiceRootRedirect &&
                !candidateAdmissionEnabled &&
                opts.channel &&
                resolveConfigPath(env) !== resolveConfigPath()
                  ? (await readUpdateChannelConfig(true)).legacyConfigPlan
                  : undefined;
              const { root, serviceRoot } = selection.refusal
                ? selection.refusal.report
                : { root: selection.target.root, serviceRoot: selection.target.managedServiceRoot };
              const packageAdmission = { serviceRoot, dryRun: opts.dryRun };
              const originalCaptureWarnings: string[] = [];
              let registeredRun: NonNullable<UpdateCommandOptions["run"]> | undefined;
              let captureStepRecorded = false;
              let captureWarningsRecorded = 0;
              // Capture steps join the run when it exists; a later capture adds its own.
              const recordCaptureSteps = () => {
                const run = registeredRun;
                if (!run) {
                  return;
                }
                const ref = initialization.originalRecoveryCapture;
                if (ref && !captureStepRecorded) {
                  captureStepRecorded = true;
                  run.originalRecoveryCapture = ref;
                  recordUpdateCommandTarget(run, {
                    step: {
                      step: "original-state-capture",
                      status: "completed",
                      detail: `Original state retained for manual recovery at ${ref.directory}.`,
                    },
                  });
                }
                while (captureWarningsRecorded < originalCaptureWarnings.length) {
                  const index = captureWarningsRecorded++;
                  recordUpdateCommandTarget(run, {
                    step: {
                      step: `warning:original-state-capture:${index + 1}`,
                      status: "completed",
                      detail: originalCaptureWarnings[index]!,
                    },
                  });
                }
              };
              const initialization: InitializedUpdate = {
                ...selection,
                env,
                runId,
                executor,
                callerLegacyConfigPlan,
                registerRun: async (run, dispose) => {
                  registerRun(run);
                  disposePresentation = dispose;
                  const recordCompletedStep = (step: string, detail: string) =>
                    recordUpdateCommandTarget(run, {
                      step: { step, status: "completed", detail },
                    });
                  for (const result of selectedTarget?.preflightSteps ?? []) {
                    for (const step of updateRunStepsFromResultStep(result)) {
                      recordUpdateCommandTarget(run, { step });
                    }
                  }
                  if (selectedTarget?.inspectionWarning) {
                    recordCompletedStep(
                      "warning:installation-inspection",
                      selectedTarget.inspectionWarning,
                    );
                  }
                  registeredRun = run;
                  if (policy.captureOriginal) {
                    // The execution owner calls this at its first state change: Gateway
                    // handoff, activation, or Doctor. Refusals and no-op runs copy nothing.
                    run.captureOriginal = async () => {
                      // The copy has its own step bound. It spends neither the operator's
                      // --timeout budget nor the executor's activation clock, as before it
                      // became lazy.
                      // A lazy copy can follow this run's own prepared package activation;
                      // the held executor fence, not package admission, proves ownership.
                      const capture = () => captureOriginal({ ownedActivation: true });
                      const outsideActivation = () =>
                        executor.exclude ? executor.exclude(capture) : capture();
                      await (run.deadline
                        ? run.deadline.exclude(outsideActivation)
                        : outsideActivation());
                      recordCaptureSteps();
                    };
                  }
                  recordCaptureSteps();
                  handleFailure = await prepareUpdateCommandFailureTriage(
                    { ...opts, invocationCwd, operatorEnv, run },
                    recoveryState.triageTarget,
                  );
                },
              };
              const warnOriginalCapture = (message: string) => {
                const detail = redactSupportString(
                  message,
                  { env, stateDir: resolveStateDir(env) },
                  { maxLength: 1000 },
                );
                originalCaptureWarnings.push(detail);
                defaultRuntime.error(`Warning: ${detail}`);
              };
              if (policy.captureOriginal && resolveDebugProxySettings(env).enabled) {
                warnOriginalCapture(
                  "Debug HTTP capture is disabled in this updater process. Doctor may enable capture in its own process after schema readiness is confirmed.",
                );
              }
              let originalCaptureAttempted = false;
              // A direct update confirms a downgrade before admission, whether or not it copies.
              const confirmDowngrade = async () => {
                if (
                  !policy.captureOriginal ||
                  !selectedTarget?.downgradeRisk ||
                  initialization.downgradeConfirmed
                ) {
                  return;
                }
                await confirmFreshUpdateDowngrade({
                  target: selectedTarget,
                  opts,
                  controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
                });
                initialization.downgradeConfirmed = true;
              };
              const runAdmitted = async () => {
                await confirmDowngrade();
                if (policy.needsInitialization) {
                  // No state database yet: the copy is cheap and records that absence
                  // before this run's history creates one.
                  await captureOriginal();
                }
                await runInitialized(initialization);
              };
              const captureOriginal = async (options?: { ownedActivation?: boolean }) => {
                if (!policy.captureOriginal || originalCaptureAttempted) {
                  return;
                }
                const fence = await executor.enter(root, {
                  preflight: true,
                  ...packageAdmission,
                });
                const authority = captureUpdateCommandExecutorAuthority(fence, runId);
                const assertCurrent = () => {
                  fence.assertCurrent();
                  if (!options?.ownedActivation) {
                    assertUpdatePackageActivationAdmission(root, packageAdmission);
                  }
                };
                const warn = warnOriginalCapture;
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
                    fullIntegrityCheck: opts.fullIntegrityCheck,
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
                  // Capture is best effort. Lead with continuation guidance because the
                  // warning is length-bounded and the nested cause can be long.
                  const space = findUpdateCaptureSpaceError(error)?.capacity;
                  warn(
                    space
                      ? `NO ORIGINAL-STATE SNAPSHOT: insufficient disk space. Needed ${space.requiredBytes} bytes (${formatDiskSpaceBytes(space.requiredBytes)}); available ${space.availableBytes} bytes (${formatDiskSpaceBytes(space.availableBytes)}). The update continues without a complete pre-update recovery copy. Free space before a future update to allow original-state capture.`
                      : `NO ORIGINAL-STATE SNAPSHOT: original state capture is unavailable. The update continues without a complete pre-update recovery copy. Database rollback uses the pre-migration snapshots taken after the Gateway stops. A completed update does not need to be restarted because of this warning. Cause: ${formatErrorMessage(error)}`,
                  );
                }
                assertCurrent();
              };
              if (initialization.refusal) {
                return await runAdmitted();
              }
              const target = initialization.target;
              if (opts.dryRun) {
                return await withUpdatePreviewSignals(opts, () =>
                  previewUpdateCommand({
                    target,
                    prepared,
                    opts,
                    runId,
                    invocationCwd,
                    updateStepTimeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                    malformedConfig: policy.malformedConfig,
                  }),
                );
              }
              const installTarget = target.packageInstallTarget;
              const stageParams = installTarget
                ? (presentation: ReturnType<typeof createUpdateProgress>) => ({
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
                    nodeRunner: target.packageUpdateNodeRunner,
                    installEnv: resolveUpdateTargetEnv({
                      baseEnv: target.packageInstallEnv,
                      serviceEnv: env,
                      invocationCwd,
                    }),
                    installTarget,
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
                                result: initialization.candidateAdmission,
                              });
                            } catch (error) {
                              if (!(error instanceof UpdatePreMutationError)) {
                                throw error;
                              }
                              throw new UnreportedUpdateAdmissionOutcome(
                                createUpdateCandidateAdmissionReport(
                                  { target, opts, prepared },
                                  error,
                                ),
                              );
                            }
                          },
                        }
                      : {}),
                  })
                : undefined;
              const artifact = !canResolveRegistryVersionForPackageTarget(
                target.packageInstallSpec ?? target.tag,
              );
              const runSelectedTarget = async () => {
                assertUpdatePackageActivationAdmission(target.root, packageAdmission);
                if (!stageParams) {
                  return await runAdmitted();
                }
                const metadata = await resolveFreshUpdateMetadata(target);
                if (!metadata) {
                  return;
                }
                const { version: targetVersion, schemaVersions: schemas } = metadata;
                if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION && !artifact) {
                  return await runAdmitted();
                }
                const timeoutMs = prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
                const candidateAdmissionChecks =
                  initialization.candidateAdmission?.verdict?.verdict === "admit"
                    ? initialization.candidateAdmission.verdict.facts.checks.map(
                        (check) => check.name,
                      )
                    : undefined;
                const checkSchemas = async () => {
                  const config = await withOwnedManagedUpdateEnv(env, () =>
                    readUpdateChannelConfig(Boolean(opts.channel), {
                      tolerateReadFailure: candidateAdmissionChecks?.includes("config"),
                    }),
                  );
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
                  return await runAdmitted();
                }
                // Initialization below writes state before execution starts.
                await captureOriginal();
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
                          checkSchemas: async () => void (await checkSchemas()),
                        });
                      } finally {
                        presentation.dispose();
                      }
                    };
                    await withUpdateInitializationCleanup(
                      () => (legacyFence ? legacyFence.run(initialize) : initialize()),
                      () => legacyFence?.release(),
                    );
                    await runAdmitted();
                  },
                  () => initializationStage?.close(),
                );
              };
              const runWithSelectedProfile = async () => {
                if (!policy.needsInitialization) {
                  return await runAdmitted();
                }
                if (artifact && stageParams) {
                  const { runFreshUpdateArtifact } = await import("./update-command-artifact.js");
                  return await runFreshUpdateArtifact(
                    { initialization, stageParams, json: Boolean(opts.json) },
                    runSelectedTarget,
                  );
                }
                if (
                  candidateAdmissionEnabled &&
                  stageParams &&
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
      return await reportUnreportedUpdateAdmissionOutcome(error, { detached: admissionAttempted });
    }
    // The admitted run's prepared handler outlives both staged cleanup and the
    // executor, so no failure is reported while either mutation owner remains live.
    await handleFailure(error);
  } finally {
    // Terminal publication must flush the last committed phases before observation ends.
    disposePresentation?.();
  }
}
