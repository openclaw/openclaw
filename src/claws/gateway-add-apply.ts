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
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { applyClawAddPlan, ClawAddMutationError, stageClawAddHostRequirements } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawCronGateway } from "./cron.js";
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

export class ClawGatewayPlanChangedError extends Error {
  constructor(message = "The Claw changed since review. Preview it again.") {
    super(message);
    this.name = "ClawGatewayPlanChangedError";
  }
}

export type GatewayClawAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

type StagedAddHandoff = {
  stage: Awaited<ReturnType<typeof stageClawAddHostRequirements>>;
  runtimeBatch: PluginInstallRuntimeBatch;
  readiness: GatewayClawAddApplyResult["readiness"];
};

export async function applyClawAddForGateway(
  input: ClawHubFetchOptions & {
    source: ClawHubCoordinate;
    agentId?: string;
    planIntegrity: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly ClawPluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly ClawSkillAcknowledgement[];
    getPlanningContext: () => Promise<GatewayClawAddPlanningContext>;
    policyConfig: { configPath: string; env: NodeJS.ProcessEnv };
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
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
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.stateDir ? { stateDir: input.stateDir } : {}),
      run: async (source, trust, persistSource) => {
        input.assertCurrent();
        const initialContext = await input.getPlanningContext();
        input.assertCurrent();
        const initialPlan = await buildGatewayClawAddPlan(source, {
          ...initialContext,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
        const initialProjection = projectGatewayClawAddPlan(
          initialPlan,
          source.source.packageRoot,
          trust,
          initialContext.config,
        );
        if (initialProjection.planIntegrity !== input.planIntegrity) {
          throw new ClawGatewayPlanChangedError();
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
              input.assertCurrent();
              lease.assertOwned();
            };
            const settleResult = (
              result: Awaited<ReturnType<typeof applyClawAddPlan>>,
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
                          ? `Claw installation needs attention: ${precedingStageCode} occurred before runtime activation failed. Review its status before retrying.`
                          : "Claw installation needs attention. Review its status before retrying.",
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
              const precedingStageError = stage.kind === "partial" ? stage.result.error : undefined;
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
                      source.source.packageRoot,
                      trust,
                      currentContext.config,
                    );
                    if (
                      currentProjection.planIntegrity !== input.planIntegrity ||
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
                    );
                    const skillConsent = bindClawSkillWarningConsent(
                      currentProjection.skillReviews,
                      input.acknowledgeSkillWarnings,
                      assertCurrent,
                    );
                    if (
                      currentProjection.pluginReviews.some(
                        (review) => review.ownerAction === "install",
                      ) &&
                      !input.reloadPlugins
                    ) {
                      throw new Error("Gateway plugin activation is unavailable for this Claw.");
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
                      persisted.source.packageRoot,
                      trust,
                      persistedContext.config,
                    );
                    if (
                      persistedProjection.planIntegrity !== input.planIntegrity ||
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
                      Parameters<typeof applyClawAddPlan>[1]
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
                        (action) => action.kind === "package" && action.details?.kind === "plugin",
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
                      consentPlanIntegrity: persistedPlan.planIntegrity,
                      ...(pluginConsent ? { pluginConsent } : {}),
                      ...(skillConsent ? { skillConsent } : {}),
                      ...(runtimeBatch ? { runtimeBatch } : {}),
                      ...(!runtimeBatch && reloadPlugins ? { reloadPlugins } : {}),
                      ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
                    };
                    const readiness = persistedProjection.readiness ?? {
                      ready: false,
                      requirements: [],
                    };
                    assertCurrent();
                    if (!runtimeBatch) {
                      const result = await applyClawAddPlan(persistedPlan, applyOptions);
                      return { kind: "settled" as const, result: settleResult(result, readiness) };
                    }
                    const stage = await stageClawAddHostRequirements(persistedPlan, applyOptions);
                    abortableStage = { stage, runtimeBatch, readiness };
                    let prepareFailure: { error: unknown } | undefined;
                    let installOwners: ReadonlyMap<string, string> | undefined;
                    try {
                      await runtimeBatch.prepare(pluginLease);
                      if (stage.kind === "ready") {
                        installOwners = await snapshotClawPluginInstallOwners(
                          pluginIds,
                          pluginLease,
                        );
                      }
                    } catch (error) {
                      prepareFailure = { error };
                      runtimeBatch.close();
                    }
                    return {
                      kind: "staged" as const,
                      stage,
                      runtimeBatch,
                      applyOptions,
                      readiness,
                      prepareFailure,
                      installOwners,
                    };
                  },
                ),
            ).catch(async (error: unknown) => {
              if (!abortableStage) {
                throw error;
              }
              abortableStage.runtimeBatch.close();
              return {
                kind: "aborted" as const,
                result: await failBatch(abortableStage, error, "package_runtime_failed"),
              };
            });
            if (prepared.kind === "settled" || prepared.kind === "aborted") {
              return prepared.result;
            }
            const { stage, runtimeBatch, applyOptions, readiness, prepareFailure, installOwners } =
              prepared;
            if (prepareFailure) {
              return await failBatch(prepared, prepareFailure.error, "package_runtime_failed");
            }
            try {
              await runtimeBatch.finish((message) => defaultRuntime.log(message));
            } catch (error) {
              return await failBatch(prepared, error, "package_runtime_failed");
            }
            if (stage.kind === "partial") {
              return settleResult(stage.result, readiness);
            }
            let continuationStarted = false;
            try {
              return await withPluginLifecycleLease(
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
                      continuationStarted = true;
                      const result = await stage.continue({
                        ...applyOptions,
                        runtimeBatch: undefined,
                        getCurrentConfig: getCurrentClawsConfig,
                      });
                      return settleResult(result, readiness);
                    },
                  ),
              );
            } catch (error) {
              if (!continuationStarted) {
                return await failBatch(prepared, error, "policy_recheck_failed");
              }
              throw error;
            }
          },
        );
      },
    });
    return resolved.value;
  } catch (error) {
    if (settledResult) {
      return {
        ...settledResult,
        status: "partial",
        error: {
          code: "post_apply_cleanup_failed",
          message: "Claw state may have changed. Review its status before retrying.",
        },
      };
    }
    throw error;
  }
}
