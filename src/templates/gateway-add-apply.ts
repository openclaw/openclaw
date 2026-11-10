import { isDeepStrictEqual } from "node:util";
import type {
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { withCurrentConfigPolicyReader } from "../config/io.runtime.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readRetainedTemplateInitialization, workspaceIdentity } from "./add-checkpoint.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import { TemplateAddMutationError } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateCronGateway, PersistedTemplateCronRef } from "./cron.js";
import { digestTemplateValue } from "./digest.js";
import {
  buildGatewayTemplateAddPlan,
  projectGatewayTemplateAddPlan,
  selectTemplateAgentWorkspace,
  type GatewayTemplateAddPlanningContext,
} from "./gateway-add-plan.js";
import { projectTemplateConfiguredAccess } from "./gateway-disclosure.js";
import { plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindTemplatePluginInstallConsent } from "./gateway-plugin-consent.js";
import { bindTemplateSkillWarningConsent } from "./gateway-skill-consent.js";
import { assertTemplatesLabsEnabled } from "./labs-gate.js";
import { assertTemplatePluginRequirementsEnabled } from "./plugin-runtime.js";
import type { TemplateAddPlan } from "./types.js";

type PreparedAgentChat = (() => Promise<void>) & {
  assertCurrent?: () => Promise<void>;
  complete?: () => Promise<void>;
  checkpoint?: (
    initialization: NonNullable<SessionEntry["templateInitialization"]>,
  ) => Promise<void>;
};

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
  agentRetained?: true;
  initializationPending?: true;
  sessionKey?: string;
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
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
    waitForAgentRuntime?: () => Promise<"applied" | "applied-restart-required">;
    prepareAgentChat?: (
      agentId: string,
      config: OpenClawConfig,
      pending?: {
        initializationPending: true;
        templateInitialization?: SessionEntry["templateInitialization"];
        recover?: true;
      },
    ) => Promise<PreparedAgentChat>;
    admissionConfigWriteOptions?: StatelessTemplateAddOptions["configWriteOptions"];
    waitForAdmissionRuntime?: () => Promise<"applied" | "applied-restart-required">;
    onAgentAdmitted?: (agent: { agentId: string; sessionKey: string }) => Promise<void>;
    onAgentReady?: StatelessTemplateAddOptions["onAgentReady"];
    onSetupEvent?: StatelessTemplateAddOptions["onSetupEvent"];
    cronGateway?: Pick<TemplateCronGateway, "add" | "list" | "writeScratch" | "enable"> &
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
  let readySessionKey: string | undefined;
  let admitted:
    | {
        agentId: string;
        workspace: string;
        config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
        chat: PreparedAgentChat;
        workspaceIdentity: string;
        configured?: { planDigest: string; sourceIntegrity: string };
      }
    | undefined;
  let initialized = false;
  const withoutAdmission = (config: OpenClawConfig): OpenClawConfig => {
    if (!admitted) {
      return config;
    }
    if (!isDeepStrictEqual(config.agents?.entries?.[admitted.agentId], admitted.config)) {
      throw new Error("The admitted agent changed before Template verification");
    }
    const entries = { ...config.agents?.entries };
    delete entries[admitted.agentId];
    return { ...config, agents: { ...config.agents, entries } };
  };
  const planningContext = async () => {
    const context = await input.getPlanningContext();
    return {
      ...context,
      config: withoutAdmission(context.config),
      ...(admitted ? { admittedWorkspace: admitted.workspace } : {}),
    };
  };
  try {
    // A reviewed UI target is an ordinary creation request, not trust in Template bytes.
    // Local durable identity and an empty guarded chat precede all remote source reads.
    if (input.agentId && input.prepareAgentChat && input.waitForAgentRuntime) {
      // Policy discovery has no persistent effects and does not depend on the
      // deletion lease. Join it before creation, retaining failures through lease cleanup.
      const admissionContext = input.getPlanningContext().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await withOpenClawStateLeaseAsync(
          {
            scope: "core:agent-deletion",
            key: normalizeAgentId(input.agentId),
            leaseMs: 60_000,
            waitMs: 5_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Template ordinary admission",
            operationLabel: "template.add.admission",
          },
          stateContext,
          async (lease) => {
            const assertCurrent = () => {
              input.assertCurrent();
              lease.assertCurrent();
            };

            const preparedContext = await admissionContext;
            if (!preparedContext.ok) {
              throw preparedContext.error;
            }
            const { config } = preparedContext.value;
            assertCurrent();

            assertTemplatesLabsEnabled(config);
            const agentId = normalizeAgentId(input.agentId!);
            const workspace = await selectTemplateAgentWorkspace(config, agentId);

            const existingConfig = config.agents?.entries?.[agentId];
            if (existingConfig) {
              const { sessionKey, continuation } = await readRetainedTemplateInitialization(
                config,
                agentId,
                workspace,
                input.source,
                assertCurrent,
              );
              const chat = await input.prepareAgentChat!(agentId, config, {
                initializationPending: true,
                templateInitialization: continuation,
                recover: true,
              });
              await chat.assertCurrent?.();
              admitted = {
                agentId,
                workspace,
                config: structuredClone(existingConfig),
                chat,
                workspaceIdentity: continuation.workspaceIdentity,
                ...(continuation.configured ? { configured: continuation.configured } : {}),
              };
              readySessionKey = sessionKey;
            } else {
              let chat: PreparedAgentChat | undefined;
              let identity = "";
              const created = await createAgentConfigEntry(
                {
                  entry: { id: agentId, name: agentId },
                  workspace,
                  deferInitialization: true,
                  beforePersistentApply: assertCurrent,
                  prepareConfigCommit: async (prospective) => {
                    assertCurrent();
                    identity = await workspaceIdentity(workspace);
                    chat = await input.prepareAgentChat!(agentId, prospective, {
                      initializationPending: true,
                      templateInitialization: {
                        source: input.source,
                        agentConfig: structuredClone(prospective.agents!.entries![agentId]!),
                        workspaceIdentity: identity,
                      },
                    });
                    identity = await workspaceIdentity(workspace);
                    return { commit: () => {}, rollback: chat };
                  },
                  onCommitted: (result) => {
                    if (result.status !== "created" || !chat) {
                      throw new Error("Ordinary admission did not create its target");
                    }
                    admitted = {
                      agentId,
                      workspace,
                      chat,
                      workspaceIdentity: identity,
                      config: structuredClone(result.config.agents!.entries![agentId]!),
                    };
                    readySessionKey = resolveAgentMainSessionKey({ cfg: result.config, agentId });
                  },
                },
                input.admissionConfigWriteOptions ?? input.configWriteOptions,
              );
              if (created.status !== "created") {
                throw new Error(
                  created.status === "error"
                    ? created.message
                    : "The requested agent already exists",
                );
              }
            }
            const applied = await (input.waitForAdmissionRuntime ?? input.waitForAgentRuntime!)();
            if (applied !== "applied") {
              throw new Error(
                "Ordinary admission requires Gateway recovery; its agent and chat were kept",
              );
            }
            assertCurrent();
            await input.onAgentAdmitted?.({ agentId, sessionKey: readySessionKey! });
          },
        );
      } finally {
        await admissionContext;
      }
    }

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
            const initialContext = await planningContext();
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
                    ...(result.agentRetained ? { agentRetained: true } : {}),
                    ...(admitted && !initialized ? { initializationPending: true } : {}),
                    ...(readySessionKey ? { sessionKey: readySessionKey } : {}),
                    readiness:
                      result.status === "partial" ? { ...readiness, ready: false } : readiness,
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
                          ...(await planningContext()),
                          config: withoutAdmission(getCurrentTemplatesConfig()),
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
                          ...(await planningContext()),
                          config: withoutAdmission(getCurrentTemplatesConfig()),
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
                              config:
                                phase === "after-agent-commit" ? config : withoutAdmission(config),
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
                        // Release planning's plugin lease before the shared installer's
                        // requirement batch activates its runtime.
                        let currentConfig = getCurrentTemplatesConfig();
                        const refreshPolicy = async () => {
                          await prepareEffect();
                          if (admitted && !initialized) {
                            await admitted.chat.assertCurrent?.();
                          }
                          await withPluginLifecycleLeaseAsync(
                            { env: input.policyConfig.env, signal: input.signal, assertCurrent },
                            (policyLease) =>
                              withCurrentConfigPolicyReader(
                                { ...input.policyConfig, lease: policyLease },
                                async (getPolicyConfig) => {
                                  currentConfig = getPolicyConfig();
                                  assertCurrent();
                                  assertTemplatesLabsEnabled(currentConfig);
                                },
                              ),
                          );
                        };
                        const reloadPlugins: PluginInstallBatchReload | undefined =
                          input.reloadPlugins
                            ? (targets, options) =>
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
                                        const assertReloadCurrent = () => {
                                          assertCurrent();
                                          options?.commitGuard?.();
                                          const config = getReloadConfig();
                                          assertTemplatesLabsEnabled(config);
                                          assertReviewedConfig(config, "after-agent-commit");
                                          assertTemplatePluginRequirementsEnabled(
                                            targets.map((target) => target.pluginId),
                                            config,
                                          );
                                        };
                                        assertReloadCurrent();
                                        return await input.reloadPlugins!(targets, {
                                          commitGuard: assertReloadCurrent,
                                        });
                                      },
                                    ),
                                )
                            : undefined;
                        const applyOptions: StatelessTemplateAddOptions = {
                          stateMode: "worker",
                          assertCurrent,
                          prepareEffect: refreshPolicy,
                          leaseSet: { context: stateContext, leases: [allocationLease, lease] },
                          getCurrentConfig: () => currentConfig,
                          assertReviewedConfig,
                          config: currentConfig,
                          ...(admitted
                            ? {
                                admittedAgent: {
                                  config: admitted.config,
                                  workspaceIdentity: admitted.workspaceIdentity,
                                  ...(admitted.configured
                                    ? { phase: "configured" as const, ...admitted.configured }
                                    : {}),
                                  assertCurrent: async () => {
                                    input.assertCurrent();
                                    await admitted!.chat.assertCurrent?.();
                                  },
                                },
                              }
                            : {}),
                          ...(admitted
                            ? {
                                onAgentConfigured: async (checkpoint) => {
                                  const pending = admitted!;
                                  if (!pending.chat.checkpoint) {
                                    throw new Error(
                                      "Template initialization checkpoint owner is unavailable",
                                    );
                                  }
                                  const configured = {
                                    planDigest: checkpoint.planDigest,
                                    sourceIntegrity: checkpoint.sourceIntegrity,
                                  };
                                  await pending.chat.checkpoint({
                                    source: input.source,
                                    agentConfig: checkpoint.config,
                                    workspaceIdentity: checkpoint.workspaceIdentity,
                                    configured,
                                  });
                                  pending.config = structuredClone(checkpoint.config);
                                  pending.workspaceIdentity = checkpoint.workspaceIdentity;
                                  pending.configured = configured;
                                },
                              }
                            : {}),
                          ...(input.prepareAgentChat && input.waitForAgentRuntime
                            ? {
                                prepareAgentSession: async (config: OpenClawConfig) => {
                                  const rollback = await input.prepareAgentChat!(
                                    persistedPlan.agent.finalId,
                                    config,
                                  );
                                  readySessionKey = resolveAgentMainSessionKey({
                                    cfg: config,
                                    agentId: persistedPlan.agent.finalId,
                                  });
                                  return rollback;
                                },
                              }
                            : {}),
                          ...(input.waitForAgentRuntime
                            ? { waitForAgentRuntime: input.waitForAgentRuntime }
                            : {}),
                          ...(input.onSetupEvent ? { onSetupEvent: input.onSetupEvent } : {}),
                          ...(input.prepareAgentChat && input.waitForAgentRuntime
                            ? {
                                onAgentReady: async (agent) => {
                                  readySessionKey = agent.sessionKey;
                                  if (admitted) {
                                    await admitted.chat.complete?.();
                                    initialized = true;
                                  }
                                  await input.onAgentReady?.(agent);
                                },
                              }
                            : {}),
                          ...(input.configWriteOptions
                            ? { configWriteOptions: input.configWriteOptions }
                            : {}),
                          consentPlanIntegrity: persistedPlan.planIntegrity,
                          ...(pluginConsent ? { pluginConsent } : {}),
                          ...(skillConsent ? { skillConsent } : {}),
                          ...(reloadPlugins ? { reloadPlugins } : {}),
                          ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
                          ...(input.rollbackNewAgent
                            ? {
                                rollbackNewAgent: (plan, cronJobs) =>
                                  input.rollbackNewAgent!(
                                    plan.agent.finalId,
                                    plan.agent.config,
                                    cronJobs,
                                  ),
                              }
                            : {}),
                        };
                        return {
                          plan: persistedPlan,
                          applyOptions,
                          readiness: persistedProjection.readiness ?? {
                            ready: false,
                            requirements: [],
                          },
                        };
                      },
                    ),
                );
                return settleResult(
                  await applyTemplateAddPlanStateless(prepared.plan, prepared.applyOptions),
                  prepared.readiness,
                );
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
    if (admitted) {
      return {
        agentId: admitted.agentId,
        status: "partial",
        agentRetained: true,
        ...(!initialized ? { initializationPending: true } : {}),
        ...(readySessionKey ? { sessionKey: readySessionKey } : {}),
        readiness: { ready: false, requirements: [] },
        error: {
          code:
            error instanceof TemplateAddMutationError
              ? error.code
              : "template_initialization_failed",
          message:
            (error instanceof Error ? error.message : String(error)) +
            " The ordinary agent and conversation were kept; do not add another copy.",
        },
      };
    }
    throw error;
  }
}
