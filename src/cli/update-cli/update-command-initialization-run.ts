import { randomUUID } from "node:crypto";
import { resolveConfigPath } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
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
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  acquireLegacyUpdateInitializationFence,
  confirmFreshUpdateDowngrade,
  initializeUpdateStateFromTarget,
  withUpdateInitializationCleanup,
  type InitializedUpdate,
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
            const packageAdmission = { serviceRoot: target.managedServiceRoot };
            const initialization: InitializedUpdate = {
              env,
              runId,
              executor,
              registerRun: async (run) => {
                registerRun(run);
                if (target.inspectionWarning) {
                  recordUpdateCommandTarget(run, {
                    step: {
                      step: "warning:installation-inspection",
                      status: "completed",
                      detail: target.inspectionWarning,
                    },
                  });
                }
                handleFailure = await prepareUpdateCommandFailureTriage(
                  { ...opts, invocationCwd, run },
                  recoveryState.triageTarget,
                );
              },
              target,
              databasePath: resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)),
              configPath: resolvePathViaExistingAncestorSync(resolveConfigPath(env)),
            };
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
            const candidateAdmissionEnabled =
              usesCandidateUpdateAdmission(opts, prepared.installKind) &&
              target.updateInstallKind === "package";
            const stageParams = (presentation: ReturnType<typeof createUpdateProgress>) => ({
              reapplyLocalOverrides: opts.reapplyLocalOverrides,
              root: target.root,
              installKind: prepared.installKind,
              tag: target.tag,
              installSpec: target.packageInstallSpec ?? undefined,
              timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
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
                          result: initialization.candidateAdmission,
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
                return await runInitialized(initialization);
              }
              const metadata = await resolveFreshUpdateMetadata(target);
              if (!metadata) {
                return;
              }
              const { version: targetVersion, schemaVersions: schemas } = metadata;
              if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION && !artifact) {
                return await runInitialized(initialization);
              }
              const timeoutMs = prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
              const selectedStoredChannel = target.storedChannel;
              const candidateAdmissionChecks =
                initialization.candidateAdmission?.verdict?.verdict === "admit"
                  ? initialization.candidateAdmission.verdict.facts.checks.map(
                      (check) => check.name,
                    )
                  : undefined;
              const checkSchemas = async (phase?: "before" | "after") => {
                const { readUpdateChannelConfig } = await import("./update-command-config.js");
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
                return await runInitialized(initialization);
              }
              const fence = await executor.enter(target.root, {
                preflight: true,
                serviceRoot: target.managedServiceRoot,
              });
              const assertCurrent = () => {
                fence.assertCurrent();
                assertUpdatePackageActivationAdmission(target.root, packageAdmission);
              };
              const { stagePackageInstallUpdate } = await import("./update-command-package.js");
              assertCurrent();
              const legacyFence = acquireLegacyUpdateInitializationFence({
                env,
                targetVersion,
                targetSchemas: schemas,
              });
              let initializationStage: InitializedUpdate["stagedPackage"];
              await withUpdateInitializationCleanup(
                async () => {
                  await withUpdateInitializationCleanup(
                    async () => {
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
                          nodeRunner: target.packageUpdateNodeRunner,
                          invocationCwd,
                          progress: presentation.progress,
                          assertCurrent,
                          checkSchemas: async (phase) => void (await checkSchemas(phase)),
                        });
                      } finally {
                        presentation.dispose();
                      }
                    },
                    () => legacyFence?.release(),
                  );
                  await runInitialized(initialization);
                },
                () => initializationStage?.close(),
              );
            };
            const runWithSelectedProfile = async () => {
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
