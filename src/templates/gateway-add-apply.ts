import type {
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { withCurrentConfigPolicyReader } from "../config/io.runtime.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  type applyTemplateAddPlanStateless,
  stageTemplateAddHostRequirementsStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import { TemplateAddMutationError } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateCronGateway, PersistedTemplateCronRef } from "./cron.js";
import { digestTemplateValue } from "./digest.js";
import {
  buildGatewayTemplateAddPlan,
  projectGatewayTemplateAddPlan,
  type GatewayTemplateAddPlanningContext,
} from "./gateway-add-plan.js";
import { projectTemplateConfiguredAccess } from "./gateway-disclosure.js";
import { plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindTemplatePluginInstallConsent } from "./gateway-plugin-consent.js";
import { bindTemplateSkillWarningConsent } from "./gateway-skill-consent.js";
import { assertTemplatesLabsEnabled } from "./labs-gate.js";
import { packageFromAction } from "./package-plan-action.js";
import {
  assertTemplatePluginInstallOwnersCurrent,
  assertTemplatePluginRequirementsEnabled,
  snapshotTemplatePluginInstallOwners,
} from "./plugin-runtime.js";
import type { TemplateAddPlan } from "./types.js";

export class TemplateGatewayPlanChangedError extends Error {
  constructor() {
    super("The Template changed since review. Preview it again.");
    this.name = "TemplateGatewayPlanChangedError";
  }
}

export class TemplateGatewayPlanBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGatewayPlanBlockedError";
  }
}

export type GatewayTemplateAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

type StagedAddHandoff = {
  stage: Awaited<ReturnType<typeof stageTemplateAddHostRequirementsStateless>>;
  runtimeBatch?: PluginInstallRuntimeBatch;
  readiness: GatewayTemplateAddApplyResult["readiness"];
};

export async function applyTemplateAddForGateway(
  input: ClawHubFetchOptions & {
    source: ClawHubCoordinate;
    agentId?: string;
    planIntegrity?: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly TemplatePluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly TemplateSkillAcknowledgement[];
    getPlanningContext: () => Promise<GatewayTemplateAddPlanningContext>;
    policyConfig: { configPath: string; env: NodeJS.ProcessEnv };
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    configWriteOptions?: StatelessTemplateAddOptions["configWriteOptions"];
    waitForAgentRuntime?: () => Promise<void>;
    cronGateway?: Pick<
      TemplateCronGateway,
      "add" | "list" | "waitUntilAgentAvailable" | "writeScratch" | "enable"
    > &
      Partial<Pick<TemplateCronGateway, "get" | "remove">>;
    rollbackNewAgent?: (
      agentId: string,
      expectedAgentConfig: TemplateAddPlan["agent"]["config"],
      expectedCronJobs: PersistedTemplateCronRef[],
    ) => Promise<void>;
  },
): Promise<GatewayTemplateAddApplyResult> {
  input.assertCurrent();
  const stateContext = captureOpenClawStateWorkerContext({ env: input.policyConfig.env });
  let settledResult: GatewayTemplateAddApplyResult | undefined;
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
        await withOpenClawStateLeaseAsync(
          {
            scope: "core:template-add-allocation",
            key: normalizeAgentId(source.manifest.agent.id),
            leaseMs: 60_000,
            waitMs: 10 * 60_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Template agent allocation",
            operationLabel: "template.add.allocation",
          },
          stateContext,
          async (allocationLease) => {
            const assertAllocationCurrent = () => {
              input.assertCurrent();
              allocationLease.assertCurrent();
            };
            assertAllocationCurrent();
            const initialContext = await input.getPlanningContext();
            assertAllocationCurrent();
            const initialPlan = await buildGatewayTemplateAddPlan(source, {
              ...initialContext,
              ...(input.agentId ? { agentId: input.agentId } : {}),
            });
            const initialProjection = projectGatewayTemplateAddPlan(
              initialPlan,
              source,
              trust,
              initialContext.config,
            );
            const expectedPlanIntegrity = input.planIntegrity ?? initialProjection.planIntegrity;
            if (initialProjection.planIntegrity !== expectedPlanIntegrity) {
              throw new TemplateGatewayPlanChangedError();
            }
            if (initialPlan.blockers.some((blocker) => blocker.code === "skill_preflight_failed")) {
              throw new TemplateGatewayPlanBlockedError(
                "A required skill is unavailable from ClawHub. The publisher must fix this Template before it can be added.",
              );
            }
            if (initialProjection.blockers.length > 0 || initialPlan.blockers.length > 0) {
              throw new TemplateGatewayPlanBlockedError(
                initialProjection.blockers[0]?.message ??
                  "This Template cannot be added right now.",
              );
            }
            return await withOpenClawStateLeaseAsync(
              {
                scope: "core:agent-deletion",
                key: initialPlan.agent.finalId,
                leaseMs: 60_000,
                waitMs: 5_000,
                heartbeat: "worker",
                signal: input.signal,
                leaseLabel: "Template add",
                operationLabel: "template.add.lease",
              },
              stateContext,
              async (lease) => {
                const assertCurrent = () => {
                  assertAllocationCurrent();
                  lease.assertCurrent();
                };
                const prepareEffect = async () => {
                  await allocationLease.assertOwned();
                  await lease.assertOwned();
                  assertCurrent();
                };
                const settleResult = (
                  result: Awaited<ReturnType<typeof applyTemplateAddPlanStateless>>,
                  readiness: GatewayTemplateAddApplyResult["readiness"],
                  precedingStageCode?: string,
                ): GatewayTemplateAddApplyResult => {
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
                const prepared = await withPluginLifecycleLeaseAsync(
                  {
                    env: input.policyConfig.env,
                    signal: input.signal,
                    assertCurrent,
                  },
                  (pluginLease) =>
                    withCurrentConfigPolicyReader(
                      { ...input.policyConfig, lease: pluginLease },
                      async (getCurrentConfig) => {
                        const getCurrentTemplatesConfig = () => {
                          const config = getCurrentConfig();
                          assertTemplatesLabsEnabled(config);
                          return config;
                        };
                        assertCurrent();
                        const currentContext = {
                          ...(await input.getPlanningContext()),
                          config: getCurrentTemplatesConfig(),
                        };
                        assertCurrent();
                        const currentPlan = await buildGatewayTemplateAddPlan(source, {
                          ...currentContext,
                          agentId: initialPlan.agent.finalId,
                        });
                        const currentProjection = projectGatewayTemplateAddPlan(
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
                          throw new TemplateGatewayPlanChangedError();
                        }
                        const pluginConsent = bindTemplatePluginInstallConsent(
                          currentProjection.pluginReviews,
                          input.acknowledgeCapabilities,
                          assertCurrent,
                          { allowCleanDirectInstall: input.planIntegrity === undefined },
                        );
                        const skillConsent = bindTemplateSkillWarningConsent(
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
                            "Gateway plugin activation is unavailable for this Template.",
                          );
                        }
                        if (
                          currentPlan.actions.some((action) => action.kind === "cronJob") &&
                          !input.cronGateway
                        ) {
                          throw new Error(
                            "Gateway schedule installation is unavailable for this Template.",
                          );
                        }
                        assertCurrent();
                        await prepareEffect();
                        const persisted = await persistSource();
                        assertCurrent();
                        const persistedContext = {
                          ...(await input.getPlanningContext()),
                          config: getCurrentTemplatesConfig(),
                        };
                        assertCurrent();
                        const persistedPlan = await buildGatewayTemplateAddPlan(persisted, {
                          ...persistedContext,
                          agentId: initialPlan.agent.finalId,
                        });
                        const persistedProjection = projectGatewayTemplateAddPlan(
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
                          throw new TemplateGatewayPlanChangedError();
                        }
                        const reviewedAccessDigest = digestTemplateValue(
                          persistedProjection.configuredAccess,
                        );
                        const reviewedDesiredDigest = digestTemplateValue(
                          persistedProjection.configuredAccess.desired,
                        );
                        const assertReviewedConfig: NonNullable<
                          Parameters<typeof applyTemplateAddPlanStateless>[1]
                        >["assertReviewedConfig"] = (config, phase) => {
                          let accessMatchesReview: boolean;
                          try {
                            const actualAccess = projectTemplateConfiguredAccess({
                              config,
                              agentId: persistedPlan.agent.finalId,
                              desiredAgent: persistedPlan.agent.config,
                              operation: phase === "after-agent-commit" ? "update" : "add",
                            });
                            accessMatchesReview =
                              phase === "after-agent-commit"
                                ? digestTemplateValue(actualAccess.current) ===
                                    reviewedDesiredDigest &&
                                  digestTemplateValue(actualAccess.desired) ===
                                    reviewedDesiredDigest
                                : digestTemplateValue(actualAccess) === reviewedAccessDigest;
                          } catch {
                            throw new TemplateAddMutationError(
                              "reviewed_access_changed",
                              "The effective Template access changed since review. Preview it again.",
                            );
                          }
                          if (!accessMatchesReview) {
                            throw new TemplateAddMutationError(
                              "reviewed_access_changed",
                              "The effective Template access changed since review. Preview it again.",
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
                              throw new Error("Template plugin requirement has no install owner");
                            }
                            return pluginId;
                          });
                        const runtimeBatch =
                          reloadPlugins && pluginIds.length > 0
                            ? new PluginInstallRuntimeBatch(
                                { env: input.policyConfig.env },
                                (targets) =>
                                  withPluginLifecycleLeaseAsync(
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
                                            assertTemplatesLabsEnabled(currentConfig);
                                            assertTemplatePluginRequirementsEnabled(
                                              pluginIds,
                                              currentConfig,
                                            );
                                            assertReviewedConfig(currentConfig);
                                            assertCurrent();
                                          };
                                          assertRuntimePolicyCurrent();
                                          await prepareEffect();
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
                          prepareEffect,
                          leaseSet: { context: stateContext, leases: [allocationLease, lease] },
                          getCurrentConfig: getCurrentTemplatesConfig,
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
                                  plan: TemplateAddPlan,
                                  cronJobs: PersistedTemplateCronRef[],
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
                        const stage = await stageTemplateAddHostRequirementsStateless(
                          persistedPlan,
                          applyOptions,
                        );
                        abortableStage = { stage, runtimeBatch, readiness };
                        await runtimeBatch?.prepare(pluginLease);
                        const installOwners =
                          stage.kind === "ready"
                            ? await snapshotTemplatePluginInstallOwners(pluginIds, pluginLease)
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
                  run: (options: StatelessTemplateAddOptions) => Promise<T>,
                ): Promise<T> =>
                  withPluginLifecycleLeaseAsync(
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
                            throw new Error("Template plugin owner snapshot is unavailable");
                          }
                          await assertTemplatePluginInstallOwnersCurrent(
                            installOwners,
                            pluginLease,
                          );
                          const requiredPluginIds = [...installOwners.keys()];
                          const getCurrentTemplatesConfig = () => {
                            const config = getCurrentConfig();
                            assertTemplatesLabsEnabled(config);
                            assertTemplatePluginRequirementsEnabled(requiredPluginIds, config);
                            return config;
                          };
                          getCurrentTemplatesConfig();
                          return await run({
                            ...applyOptions,
                            runtimeBatch: undefined,
                            getCurrentConfig: getCurrentTemplatesConfig,
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
      defaultRuntime.log("Template source cleanup failed after Add; cached files may remain.");
      return settledResult;
    }
    throw error;
  }
}
