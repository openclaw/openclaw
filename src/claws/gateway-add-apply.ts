import type {
  ClawPluginAcknowledgement,
  ClawSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { withCurrentConfigPolicyReader } from "../config/io.runtime.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  type applyClawAddPlanStateless,
  stageClawAddHostRequirementsStateless,
  type StatelessClawAddOptions,
} from "./add-stateless.js";
import { ClawAddMutationError } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawCronGateway, PersistedClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import {
  buildGatewayClawAddPlan,
  projectGatewayClawAddPlan,
  type GatewayClawAddPlanningContext,
} from "./gateway-add-plan.js";
import { projectClawConfiguredAccess } from "./gateway-disclosure.js";
import { plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { bindClawSkillWarningConsent } from "./gateway-skill-consent.js";
import { assertClawsLabsEnabled } from "./labs-gate.js";
import { packageFromAction } from "./package-plan-action.js";
import {
  assertClawPluginInstallOwnersCurrent,
  assertClawPluginRequirementsEnabled,
  snapshotClawPluginInstallOwners,
} from "./plugin-runtime.js";
import type { ClawAddPlan } from "./types.js";

export class ClawGatewayPlanChangedError extends Error {
  constructor(message = "The Claw changed since review. Preview it again.") {
    super(message);
    this.name = "ClawGatewayPlanChangedError";
  }
}

export class ClawGatewayPlanBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawGatewayPlanBlockedError";
  }
}

export type GatewayClawAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

type StagedAddHandoff = {
  stage: Awaited<ReturnType<typeof stageClawAddHostRequirementsStateless>>;
  runtimeBatch?: PluginInstallRuntimeBatch;
  readiness: GatewayClawAddApplyResult["readiness"];
};

export async function applyClawAddForGateway(
  input: ClawHubFetchOptions & {
    source: ClawHubCoordinate;
    agentId?: string;
    planIntegrity?: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly ClawPluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly ClawSkillAcknowledgement[];
    getPlanningContext: () => Promise<GatewayClawAddPlanningContext>;
    policyConfig: { configPath: string; env: NodeJS.ProcessEnv };
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    configWriteOptions?: StatelessClawAddOptions["configWriteOptions"];
    waitForAgentRuntime?: () => Promise<void>;
    cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable"> &
      Partial<Pick<ClawCronGateway, "get" | "remove">>;
    rollbackNewAgent?: (
      agentId: string,
      expectedAgentConfig: ClawAddPlan["agent"]["config"],
      expectedCronJobs: PersistedClawCronRef[],
    ) => Promise<void>;
  },
): Promise<GatewayClawAddApplyResult> {
  input.assertCurrent();
  let settledResult: GatewayClawAddApplyResult | undefined;
  try {
    const resolved = await withResolvedClawHubSource({
      coordinate: input.source,
      mode: "apply",
      ...(input.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.stateDir ? { stateDir: input.stateDir } : {}),
      run: async (source, trust, persistSource) =>
        await withOpenClawStateLease(
          {
            scope: "core:claw-add-allocation",
            key: normalizeAgentId(source.manifest.agent.id),
            database: { scope: "shared", options: {} },
            leaseMs: 60_000,
            waitMs: 10 * 60_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Claw agent allocation",
            operationLabel: "claw.add.allocation",
          },
          async (allocationLease) => {
            const assertAllocationCurrent = () => {
              input.assertCurrent();
              allocationLease.assertOwned();
            };
            assertAllocationCurrent();
            const initialContext = await input.getPlanningContext();
            assertAllocationCurrent();
            const initialPlan = await buildGatewayClawAddPlan(source, {
              ...initialContext,
              ...(input.agentId ? { agentId: input.agentId } : {}),
            });
            const initialProjection = projectGatewayClawAddPlan(
              initialPlan,
              source,
              trust,
              initialContext.config,
            );
            const expectedPlanIntegrity = input.planIntegrity ?? initialProjection.planIntegrity;
            if (initialProjection.planIntegrity !== expectedPlanIntegrity) {
              throw new ClawGatewayPlanChangedError();
            }
            if (initialPlan.blockers.some((blocker) => blocker.code === "skill_preflight_failed")) {
              throw new ClawGatewayPlanBlockedError(
                "A required skill is unavailable from ClawHub. The publisher must fix this Claw before it can be added.",
              );
            }
            if (initialProjection.blockers.length > 0 || initialPlan.blockers.length > 0) {
              throw new ClawGatewayPlanBlockedError(
                initialProjection.blockers[0]?.message ?? "This Claw cannot be added right now.",
              );
            }
            return await withOpenClawStateLease(
              {
                scope: "core:agent-deletion",
                key: initialPlan.agent.finalId,
                database: { scope: "shared", options: {} },
                leaseMs: 60_000,
                waitMs: 5_000,
                heartbeat: "worker",
                signal: input.signal,
                leaseLabel: "Claw add",
                operationLabel: "claw.add.lease",
              },
              async (lease) => {
                const assertCurrent = () => {
                  assertAllocationCurrent();
                  lease.assertOwned();
                };
                const settleResult = (
                  result: Awaited<ReturnType<typeof applyClawAddPlanStateless>>,
                  readiness: GatewayClawAddApplyResult["readiness"],
                  precedingStageCode?: string,
                ): GatewayClawAddApplyResult => {
                  settledResult = {
                    agentId: result.agent.finalId,
                    status: result.status,
                    readiness,
                    ...(result.error
                      ? {
                          error: {
                            code: result.error.code,
                            message: precedingStageCode
                              ? `${precedingStageCode}: ${result.error.message}`
                              : result.error.message,
                          },
                        }
                      : {}),
                  };
                  return settledResult;
                };
                const failBatch = async (
                  { stage, readiness }: StagedAddHandoff,
                  error: unknown,
                  code: string,
                ) => {
                  const precedingStageError =
                    stage.kind === "partial" ? stage.result.error : undefined;
                  const failureMessage = error instanceof Error ? error.message : String(error);
                  const result =
                    stage.kind === "ready"
                      ? await stage.failBeforeContinue(error, code)
                      : {
                          ...stage.result,
                          error: {
                            code,
                            message: [precedingStageError?.message, failureMessage]
                              .filter(Boolean)
                              .join("\n"),
                          },
                        };
                  return settleResult(result, readiness, precedingStageError?.code);
                };
                let abortableStage: StagedAddHandoff | undefined;
                const prepared = await withPluginLifecycleLease(
                  {
                    env: input.policyConfig.env,
                    signal: input.signal,
                    assertCurrent,
                  },
                  (pluginLease) =>
                    withCurrentConfigPolicyReader(
                      { ...input.policyConfig, lease: pluginLease },
                      async (getCurrentConfig) => {
                        const getCurrentClawsConfig = () => {
                          const config = getCurrentConfig();
                          assertClawsLabsEnabled(config);
                          return config;
                        };
                        assertCurrent();
                        const currentContext = {
                          ...(await input.getPlanningContext()),
                          config: getCurrentClawsConfig(),
                        };
                        assertCurrent();
                        const currentPlan = await buildGatewayClawAddPlan(source, {
                          ...currentContext,
                          agentId: initialPlan.agent.finalId,
                        });
                        const currentProjection = projectGatewayClawAddPlan(
                          currentPlan,
                          source,
                          trust,
                          currentContext.config,
                        );
                        if (
                          currentProjection.planIntegrity !== expectedPlanIntegrity ||
                          currentProjection.blockers.length > 0 ||
                          currentPlan.blockers.length > 0 ||
                          currentPlan.actions.some((action) => action.blocked)
                        ) {
                          throw new ClawGatewayPlanChangedError();
                        }
                        const pluginConsent = bindClawPluginInstallConsent(
                          currentProjection.pluginReviews,
                          input.acknowledgeCapabilities,
                          assertCurrent,
                          { allowCleanDirectInstall: input.planIntegrity === undefined },
                        );
                        const skillConsent = bindClawSkillWarningConsent(
                          currentProjection.skillReviews,
                          input.acknowledgeSkillWarnings,
                          assertCurrent,
                          { directInstall: input.planIntegrity === undefined },
                        );
                        if (
                          currentProjection.pluginReviews.some(
                            (review) => review.ownerAction === "install",
                          ) &&
                          !input.reloadPlugins
                        ) {
                          throw new Error(
                            "Gateway plugin activation is unavailable for this Claw.",
                          );
                        }
                        if (
                          currentPlan.actions.some((action) => action.kind === "cronJob") &&
                          !input.cronGateway
                        ) {
                          throw new Error(
                            "Gateway schedule installation is unavailable for this Claw.",
                          );
                        }
                        assertCurrent();
                        const persisted = await persistSource();
                        assertCurrent();
                        const persistedContext = {
                          ...(await input.getPlanningContext()),
                          config: getCurrentClawsConfig(),
                        };
                        assertCurrent();
                        const persistedPlan = await buildGatewayClawAddPlan(persisted, {
                          ...persistedContext,
                          agentId: initialPlan.agent.finalId,
                        });
                        const persistedProjection = projectGatewayClawAddPlan(
                          persistedPlan,
                          persisted,
                          trust,
                          persistedContext.config,
                        );
                        if (
                          persistedProjection.planIntegrity !== expectedPlanIntegrity ||
                          !persistedProjection.configuredAccess?.desired ||
                          persistedProjection.blockers.length > 0 ||
                          persistedPlan.blockers.length > 0 ||
                          persistedPlan.actions.some((action) => action.blocked) ||
                          !plansMatchAcrossSourceRoots({
                            preview: currentPlan,
                            previewRoot: source.source.packageRoot,
                            persisted: persistedPlan,
                            persistedRoot: persisted.source.packageRoot,
                          })
                        ) {
                          throw new ClawGatewayPlanChangedError();
                        }
                        const reviewedAccessDigest = digestClawValue(
                          persistedProjection.configuredAccess,
                        );
                        const reviewedDesiredDigest = digestClawValue(
                          persistedProjection.configuredAccess.desired,
                        );
                        const assertReviewedConfig: NonNullable<
                          Parameters<typeof applyClawAddPlanStateless>[1]
                        >["assertReviewedConfig"] = (config, phase) => {
                          let accessMatchesReview: boolean;
                          try {
                            const actualAccess = projectClawConfiguredAccess({
                              config,
                              agentId: persistedPlan.agent.finalId,
                              desiredAgent: persistedPlan.agent.config,
                              operation: phase === "after-agent-commit" ? "update" : "add",
                            });
                            accessMatchesReview =
                              phase === "after-agent-commit"
                                ? digestClawValue(actualAccess.current) === reviewedDesiredDigest &&
                                  digestClawValue(actualAccess.desired) === reviewedDesiredDigest
                                : digestClawValue(actualAccess) === reviewedAccessDigest;
                          } catch {
                            throw new ClawAddMutationError(
                              "reviewed_access_changed",
                              "The effective Claw access changed since review. Preview it again.",
                            );
                          }
                          if (!accessMatchesReview) {
                            throw new ClawAddMutationError(
                              "reviewed_access_changed",
                              "The effective Claw access changed since review. Preview it again.",
                            );
                          }
                        };
                        const reloadPlugins = input.reloadPlugins;
                        const pluginIds = persistedPlan.actions
                          .filter(
                            (action) =>
                              action.kind === "package" && action.details?.kind === "plugin",
                          )
                          .map((action) => {
                            const pluginId = packageFromAction(action).installId;
                            if (!pluginId) {
                              throw new Error("Claw plugin requirement has no install owner");
                            }
                            return pluginId;
                          });
                        const runtimeBatch =
                          reloadPlugins && pluginIds.length > 0
                            ? new PluginInstallRuntimeBatch(
                                { env: input.policyConfig.env },
                                (targets) =>
                                  withPluginLifecycleLease(
                                    {
                                      env: input.policyConfig.env,
                                      signal: input.signal,
                                      assertCurrent,
                                    },
                                    (reloadLease) =>
                                      withCurrentConfigPolicyReader(
                                        { ...input.policyConfig, lease: reloadLease },
                                        async (getReloadConfig) => {
                                          const assertRuntimePolicyCurrent = () => {
                                            assertCurrent();
                                            const currentConfig = getReloadConfig();
                                            assertClawsLabsEnabled(currentConfig);
                                            assertClawPluginRequirementsEnabled(
                                              pluginIds,
                                              currentConfig,
                                            );
                                            assertReviewedConfig(currentConfig);
                                            assertCurrent();
                                          };
                                          assertRuntimePolicyCurrent();
                                          return await reloadPlugins(targets, {
                                            commitGuard: assertRuntimePolicyCurrent,
                                          });
                                        },
                                      ),
                                  ),
                              )
                            : undefined;
                        const applyOptions = {
                          stateMode: "worker" as const,
                          assertCurrent,
                          getCurrentConfig: getCurrentClawsConfig,
                          assertReviewedConfig,
                          config: persistedContext.config,
                          ...(input.configWriteOptions
                            ? { configWriteOptions: input.configWriteOptions }
                            : {}),
                          consentPlanIntegrity: persistedPlan.planIntegrity,
                          ...(pluginConsent ? { pluginConsent } : {}),
                          ...(skillConsent ? { skillConsent } : {}),
                          ...(runtimeBatch ? { runtimeBatch } : {}),
                          ...(!runtimeBatch && reloadPlugins ? { reloadPlugins } : {}),
                          ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
                          ...(input.rollbackNewAgent
                            ? {
                                rollbackNewAgent: (
                                  plan: ClawAddPlan,
                                  cronJobs: PersistedClawCronRef[],
                                ) =>
                                  input.rollbackNewAgent!(
                                    plan.agent.finalId,
                                    plan.agent.config,
                                    cronJobs,
                                  ),
                              }
                            : {}),
                        };
                        const readiness = persistedProjection.readiness ?? {
                          ready: false,
                          requirements: [],
                        };
                        assertCurrent();
                        const stage = await stageClawAddHostRequirementsStateless(
                          persistedPlan,
                          applyOptions,
                        );
                        abortableStage = { stage, runtimeBatch, readiness };
                        await runtimeBatch?.prepare(pluginLease);
                        const installOwners =
                          stage.kind === "ready"
                            ? await snapshotClawPluginInstallOwners(pluginIds, pluginLease)
                            : undefined;
                        return {
                          kind: "staged" as const,
                          stage,
                          runtimeBatch,
                          applyOptions,
                          readiness,
                          installOwners,
                        };
                      },
                    ),
                ).catch(async (error: unknown) => {
                  if (!abortableStage) {
                    throw error;
                  }
                  abortableStage.runtimeBatch?.close();
                  return {
                    kind: "aborted" as const,
                    result: await failBatch(abortableStage, error, "package_runtime_failed"),
                  };
                });
                if (prepared.kind === "aborted") {
                  return prepared.result;
                }
                const { stage, runtimeBatch, applyOptions, readiness, installOwners } = prepared;
                try {
                  await runtimeBatch?.finish((message) => defaultRuntime.log(message));
                } catch (error) {
                  return await failBatch(prepared, error, "package_runtime_failed");
                }
                if (stage.kind === "partial") {
                  return settleResult(stage.result, readiness);
                }
                const withCurrentAddPolicy = async <T>(
                  run: (options: StatelessClawAddOptions) => Promise<T>,
                ): Promise<T> =>
                  withPluginLifecycleLease(
                    {
                      env: input.policyConfig.env,
                      signal: input.signal,
                      assertCurrent,
                    },
                    (pluginLease) =>
                      withCurrentConfigPolicyReader(
                        { ...input.policyConfig, lease: pluginLease },
                        async (getCurrentConfig) => {
                          if (!installOwners) {
                            throw new Error("Claw plugin owner snapshot is unavailable");
                          }
                          await assertClawPluginInstallOwnersCurrent(installOwners, pluginLease);
                          const requiredPluginIds = [...installOwners.keys()];
                          const getCurrentClawsConfig = () => {
                            const config = getCurrentConfig();
                            assertClawsLabsEnabled(config);
                            assertClawPluginRequirementsEnabled(requiredPluginIds, config);
                            return config;
                          };
                          getCurrentClawsConfig();
                          return await run({
                            ...applyOptions,
                            runtimeBatch: undefined,
                            getCurrentConfig: getCurrentClawsConfig,
                          });
                        },
                      ),
                  );
                let continuationStarted = false;
                const agentStage = await withCurrentAddPolicy(async (options) => {
                  continuationStarted = true;
                  return await stage.stageAgent(options);
                }).catch(async (error: unknown) => {
                  if (continuationStarted) {
                    throw error;
                  }
                  return {
                    kind: "partial" as const,
                    result: await stage.failBeforeContinue(error, "policy_recheck_failed"),
                  };
                });
                if (agentStage.kind === "partial") {
                  return settleResult(agentStage.result, readiness);
                }
                // The reload owner needs the plugin lease to admit the new agent's
                // database and publish its runtime roster before cron can use it.
                try {
                  await input.waitForAgentRuntime?.();
                  assertCurrent();
                } catch (error) {
                  return settleResult(
                    await agentStage.fail(error, "agent_runtime_failed"),
                    readiness,
                  );
                }
                let finishStarted = false;
                try {
                  return await withCurrentAddPolicy(async (options) => {
                    finishStarted = true;
                    return settleResult(await agentStage.finish(options), readiness);
                  });
                } catch (error) {
                  if (finishStarted) {
                    throw error;
                  }
                  return settleResult(
                    await agentStage.fail(error, "policy_recheck_failed"),
                    readiness,
                  );
                }
              },
            );
          },
        ),
    });
    return resolved.value;
  } catch (error) {
    if (settledResult) {
      defaultRuntime.log("Claw source cleanup failed after Add; cached files may remain.");
      return settledResult;
    }
    throw error;
  }
}
