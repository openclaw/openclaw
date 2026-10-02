import type {
  ClawPluginAcknowledgement,
  ClawSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { withCurrentConfigPolicyReader } from "../config/io.runtime.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawCronGateway } from "./cron.js";
import { digestClawValue } from "./digest.js";
import {
  ClawGatewayPlanChangedError,
  type GatewayClawAddApplyResult,
} from "./gateway-add-apply.js";
import { projectClawConfiguredAccess } from "./gateway-disclosure.js";
import {
  buildGatewayClawUpdatePlan,
  prepareGatewayClawUpdatePlanning,
} from "./gateway-lifecycle-plan.js";
import { bindClawLifecycleTrust, plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { bindClawSkillWarningConsent } from "./gateway-skill-consent.js";
import { assertClawsLabsEnabled } from "./labs-gate.js";
import {
  assertClawPluginInstallOwnersCurrent,
  assertClawPluginRequirementsEnabled,
  snapshotClawPluginInstallOwners,
} from "./plugin-runtime.js";
import {
  applyClawUpdatePlan,
  ClawUpdateMutationError,
  stageClawUpdateHostRequirements,
  type ClawUpdateApplyOptions,
} from "./update-apply.js";

const log = createSubsystemLogger("claws/gateway-update");

export async function applyClawUpdateForGateway(
  input: ClawHubFetchOptions & {
    agentId: string;
    source: ClawHubCoordinate;
    planIntegrity: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly ClawPluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly ClawSkillAcknowledgement[];
    getRuntimeConfig: () => OpenClawConfig;
    policyConfig: { configPath: string; env: NodeJS.ProcessEnv };
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    cronGateway?: ClawCronGateway;
  },
): Promise<GatewayClawAddApplyResult> {
  input.assertCurrent();
  const clawHubBaseUrl = process.env.OPENCLAW_CLAWHUB_URL ?? process.env.CLAWHUB_URL;
  const initialConfig = input.getRuntimeConfig();
  const initialPrepared = await prepareGatewayClawUpdatePlanning({
    agentId: input.agentId,
    source: input.source,
    config: initialConfig,
    assertCurrent: input.assertCurrent,
  });
  input.assertCurrent();
  let mayHaveChanged = false;
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
        const initial = await buildGatewayClawUpdatePlan({
          agentId: input.agentId,
          source,
          config: initialConfig,
          prepared: initialPrepared,
        });
        const initialProjection = bindClawLifecycleTrust(initial.projection, trust);
        if (initialProjection.planIntegrity !== input.planIntegrity) {
          throw new ClawGatewayPlanChangedError();
        }
        return await withOpenClawStateLease(
          {
            scope: "core:agent-deletion",
            key: input.agentId,
            database: { scope: "shared", options: {} },
            leaseMs: 60_000,
            waitMs: 5_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Claw update",
            operationLabel: "claw.update.lease",
          },
          async (lease) => {
            const assertCurrent = () => {
              input.assertCurrent();
              lease.assertOwned();
            };
            let stagedHandoff:
              | {
                  batch: PluginInstallRuntimeBatch;
                  stage: Awaited<ReturnType<typeof stageClawUpdateHostRequirements>> | undefined;
                }
              | undefined;
            const firstPhase = await withPluginLifecycleLease(
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
                    const planCurrent = async (verifiedSource: typeof source) => {
                      assertCurrent();
                      const config = getCurrentClawsConfig();
                      const prepared = await prepareGatewayClawUpdatePlanning({
                        agentId: input.agentId,
                        source: input.source,
                        config,
                        assertCurrent,
                      });
                      const built = await buildGatewayClawUpdatePlan({
                        agentId: input.agentId,
                        source: verifiedSource,
                        config,
                        prepared,
                      });
                      assertCurrent();
                      return {
                        ...built,
                        config,
                        projection: bindClawLifecycleTrust(built.projection, trust),
                      };
                    };
                    const current = await planCurrent(source);
                    if (
                      current.projection.planIntegrity !== input.planIntegrity ||
                      current.projection.blockers.length > 0 ||
                      current.plan.blockers.length > 0 ||
                      current.plan.actions.some((action) => action.blocked)
                    ) {
                      throw new ClawGatewayPlanChangedError();
                    }
                    const pluginConsent = bindClawPluginInstallConsent(
                      current.projection.pluginReviews,
                      input.acknowledgeCapabilities,
                      assertCurrent,
                    );
                    const skillConsent = bindClawSkillWarningConsent(
                      current.projection.skillReviews,
                      input.acknowledgeSkillWarnings,
                      assertCurrent,
                    );
                    if (
                      current.projection.pluginReviews.some(
                        (review) => review.ownerAction === "install",
                      ) &&
                      !input.reloadPlugins
                    ) {
                      throw new Error(
                        "Gateway plugin activation is unavailable for this Claw update.",
                      );
                    }
                    if (
                      current.plan.actions.some(
                        (action) => action.kind === "cronJob" && action.action !== "unchanged",
                      ) &&
                      !input.cronGateway
                    ) {
                      throw new Error("Gateway schedule updates are unavailable for this Claw.");
                    }
                    assertCurrent();
                    mayHaveChanged = true;
                    const persisted = await persistSource();
                    const persistedPlan = await planCurrent(persisted);
                    const reviewedAccess = persistedPlan.projection.configuredAccess;
                    if (
                      persistedPlan.projection.planIntegrity !== input.planIntegrity ||
                      persistedPlan.projection.blockers.length > 0 ||
                      !reviewedAccess?.desired ||
                      persistedPlan.plan.blockers.length > 0 ||
                      persistedPlan.plan.actions.some((action) => action.blocked) ||
                      !plansMatchAcrossSourceRoots({
                        preview: current.plan,
                        previewRoot: source.source.packageRoot,
                        persisted: persistedPlan.plan,
                        persistedRoot: persisted.source.packageRoot,
                      })
                    ) {
                      throw new ClawGatewayPlanChangedError();
                    }
                    const reviewedAccessDigest = digestClawValue(reviewedAccess);
                    const reviewedDesiredDigest = digestClawValue(reviewedAccess.desired);
                    assertCurrent();
                    const target = {
                      targetManifest: persisted.manifest,
                      targetClawMarkdownBody: persisted.clawMarkdownBody,
                      targetOpenClawProfile: persisted.openClawProfile,
                      targetSource: persisted.source,
                    };
                    let reviewedDesiredAgent: AgentConfig | undefined;
                    const updateOptions: ClawUpdateApplyOptions = {
                      ...persistedPlan.stateOptions,
                      stateMode: "worker",
                      assertCurrent,
                      getCurrentConfig: getCurrentClawsConfig,
                      assertReviewedConfig: (config, desiredAgent, phase) => {
                        reviewedDesiredAgent = desiredAgent;
                        let actualAccessMatchesReview: boolean;
                        try {
                          const actualAccess = projectClawConfiguredAccess({
                            config,
                            agentId: persistedPlan.plan.agentId,
                            desiredAgent,
                            operation: "update",
                          });
                          actualAccessMatchesReview =
                            phase === "after-agent-commit"
                              ? digestClawValue(actualAccess.current) === reviewedDesiredDigest &&
                                digestClawValue(actualAccess.desired) === reviewedDesiredDigest
                              : digestClawValue(actualAccess) === reviewedAccessDigest;
                        } catch {
                          throw new ClawUpdateMutationError(
                            "reviewed_access_changed",
                            "The effective Claw access changed since review. Preview it again.",
                          );
                        }
                        if (!actualAccessMatchesReview) {
                          throw new ClawUpdateMutationError(
                            "reviewed_access_changed",
                            "The effective Claw access changed since review. Preview it again.",
                          );
                        }
                      },
                      config: persistedPlan.config,
                      ...(clawHubBaseUrl ? { clawHubBaseUrl } : {}),
                      sourceMcpServers: persistedPlan.sourceMcpServers,
                      packagePreflight: persistedPlan.packagePreflight,
                      planPackageDeps: persistedPlan.packageDeps,
                      consentPlanIntegrity: persistedPlan.plan.planIntegrity,
                      ...(pluginConsent ? { pluginConsent } : {}),
                      ...(skillConsent ? { skillConsent } : {}),
                      ...(input.reloadPlugins ? { reloadPlugins: input.reloadPlugins } : {}),
                      ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
                    };
                    const readiness = persistedPlan.projection.readiness ?? {
                      ready: false,
                      requirements: [],
                    };
                    if (!input.reloadPlugins) {
                      const result = await applyClawUpdatePlan(
                        persistedPlan.plan,
                        target,
                        updateOptions,
                      );
                      settledResult = { agentId: result.agentId, status: result.status, readiness };
                      return { kind: "settled" as const, value: settledResult };
                    }

                    const batch = new PluginInstallRuntimeBatch(
                      persistedPlan.stateOptions,
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
                                const assertReloadPolicy = () => {
                                  assertCurrent();
                                  const config = getReloadConfig();
                                  assertClawsLabsEnabled(config);
                                  assertClawPluginRequirementsEnabled(
                                    stage?.requiredPluginIds ?? [],
                                    config,
                                  );
                                  if (!reviewedDesiredAgent) {
                                    throw new ClawUpdateMutationError(
                                      "reviewed_access_changed",
                                      "The effective Claw access changed since review. Preview it again.",
                                    );
                                  }
                                  updateOptions.assertReviewedConfig?.(
                                    config,
                                    reviewedDesiredAgent,
                                  );
                                  assertCurrent();
                                };
                                assertReloadPolicy();
                                return await input.reloadPlugins!(targets, {
                                  commitGuard: assertReloadPolicy,
                                });
                              },
                            ),
                        ),
                    );
                    let stage:
                      | Awaited<ReturnType<typeof stageClawUpdateHostRequirements>>
                      | undefined;
                    let stageError: unknown;
                    let stageFailed = false;
                    try {
                      stage = await stageClawUpdateHostRequirements(persistedPlan.plan, target, {
                        ...updateOptions,
                        runtimeBatch: batch,
                      });
                    } catch (error) {
                      stageFailed = true;
                      stageError = error;
                    }
                    if (stage && !stage.needsRuntimeHandoff) {
                      batch.close();
                      const result = await stage.continue(updateOptions);
                      settledResult = { agentId: result.agentId, status: result.status, readiness };
                      return { kind: "settled" as const, value: settledResult };
                    }
                    let ownerSnapshot: ReadonlyMap<string, string> | undefined;
                    try {
                      await batch.prepare(pluginLease);
                      if (stage) {
                        ownerSnapshot = await snapshotClawPluginInstallOwners(
                          stage.requiredPluginIds,
                          pluginLease,
                        );
                      }
                    } catch (error) {
                      batch.close();
                      if (stage) {
                        await stage.failRuntime(error);
                      }
                      if (stageFailed) {
                        throw new AggregateError(
                          [stageError, error],
                          "Claw update staging and plugin preparation failed",
                          { cause: error },
                        );
                      }
                      throw error;
                    }
                    stagedHandoff = { batch, stage };
                    return {
                      kind: "staged" as const,
                      batch,
                      stage,
                      stageError,
                      stageFailed,
                      ownerSnapshot,
                      updateOptions,
                      readiness,
                    };
                  },
                ),
            ).catch(async (error: unknown) => {
              const handoff = stagedHandoff;
              if (handoff) {
                handoff.batch.close();
                if (handoff.stage) {
                  await handoff.stage.failRuntime(error);
                }
              }
              throw error;
            });
            stagedHandoff = undefined;
            if (firstPhase.kind === "settled") {
              return firstPhase.value;
            }
            let runtimeFailure: { error: unknown } | undefined;
            try {
              await firstPhase.batch.finish((message) => log.warn(message));
            } catch (error) {
              runtimeFailure = { error };
            }
            if (firstPhase.stageFailed) {
              if (runtimeFailure) {
                throw new AggregateError(
                  [firstPhase.stageError, runtimeFailure.error],
                  "Claw update staging and plugin activation failed",
                );
              }
              throw firstPhase.stageError;
            }
            const stage = firstPhase.stage;
            if (!stage) {
              throw new Error("Claw update requirement stage did not settle");
            }
            if (runtimeFailure) {
              return await stage.failRuntime(runtimeFailure.error);
            }
            let continuationStarted = false;
            let result: Awaited<ReturnType<typeof stage.continue>>;
            try {
              result = await withPluginLifecycleLease(
                {
                  env: input.policyConfig.env,
                  signal: input.signal,
                  assertCurrent,
                },
                (pluginLease) =>
                  withCurrentConfigPolicyReader(
                    { ...input.policyConfig, lease: pluginLease },
                    async (getCurrentConfig) => {
                      if (firstPhase.ownerSnapshot) {
                        await assertClawPluginInstallOwnersCurrent(
                          firstPhase.ownerSnapshot,
                          pluginLease,
                        );
                      }
                      const getCurrentClawsConfig = () => {
                        const config = getCurrentConfig();
                        assertClawsLabsEnabled(config);
                        assertClawPluginRequirementsEnabled(stage.requiredPluginIds, config);
                        return config;
                      };
                      getCurrentClawsConfig();
                      continuationStarted = true;
                      return await stage.continue({
                        ...firstPhase.updateOptions,
                        getCurrentConfig: getCurrentClawsConfig,
                      });
                    },
                  ),
              );
            } catch (error) {
              if (!continuationStarted) {
                await stage.failRuntime(error);
              }
              throw error;
            }
            settledResult = {
              agentId: result.agentId,
              status: result.status,
              readiness: firstPhase.readiness,
            };
            return settledResult;
          },
        );
      },
    });
    return resolved.value;
  } catch (error) {
    if (mayHaveChanged || settledResult) {
      log.error(
        `Claw update outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        agentId: input.agentId,
        status: "partial",
        readiness: settledResult?.readiness ?? { ready: false, requirements: [] },
        error: {
          code: "update_outcome_uncertain",
          message: "Claw state may have changed. Review its status before retrying.",
        },
      };
    }
    throw error;
  }
}
