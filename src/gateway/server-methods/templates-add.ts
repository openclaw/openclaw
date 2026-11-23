import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateTemplatesAddApplyParams,
  validateTemplatesAddPlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  TemplateLifecyclePlanResult,
  TemplatesAddApplyParams,
  TemplatesAddPlanParams,
} from "../../../packages/gateway-protocol/src/schema/templates.js";
import { resolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { readCurrentConfigForPolicyCheckAsync } from "../../config/io.runtime.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import { resolveConfigPath } from "../../config/paths.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../../plugins/install-runtime-batch.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { TemplateAddMutationError } from "../../templates/add-mutation-error.js";
import { assertTemplatesEnabled, TemplatesDisabledError } from "../../templates/availability.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
import { createTemplateCronGateway } from "../../templates/cron-gateway.js";
import {
  templateCronGatewayJobMatchesRef,
  type PersistedTemplateCronRef,
} from "../../templates/cron.js";
import {
  applyTemplateAddForGateway,
  TemplateGatewayPlanBlockedError,
  TemplateGatewayPlanChangedError,
} from "../../templates/gateway-add-apply.js";
import { planTemplateAddForGateway } from "../../templates/gateway-add-plan.js";
import type { GatewayTemplateAddApplyResult } from "../../templates/gateway-add-result.js";
import type {
  TemplateAddDiagnosticStage,
  TemplateAddStageHook,
} from "../../templates/gateway-add-source.js";
import { TemplateGatewayConsentError } from "../../templates/gateway-plugin-consent.js";
import { TemplateSkillConsentError } from "../../templates/gateway-skill-consent.js";
import { resolveTemplatePreferredModel } from "../../templates/preferred-model.js";
import { TemplateProjectError } from "../../templates/project.js";
import { buildTemplateOpeningMessage } from "../../templates/setup-prompt.js";
import { measureTemplateAddStage, withTemplateAddTimings } from "../../templates/timings.js";
import type { TemplateAddPlan } from "../../templates/types.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";
import {
  completeAgentOnboarding,
  startAgentOnboardingConversation,
  startTemplateDependencyConversation,
} from "./agents-onboarding.js";
import { captureCronCreatorSession } from "./cron-input-validation.js";
import { publishTemplateInstallEvent } from "./templates-add-conversation.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/templates-add");

// One terminal record per request; never serialize request data or caught errors.
function templateAddDiagnostic(operation: "plan" | "apply") {
  const correlationId = randomUUID();
  const started = performance.now();
  return (
    stage: "params" | "policy" | TemplateAddDiagnosticStage,
    outcome: "success" | "partial" | "invalid_params" | "forbidden" | "failed",
    sourceKind?: "local" | "upload" | "clawhub",
  ) => {
    const metadata = {
      operation,
      stage,
      outcome,
      correlationId,
      durationMs: Math.round(performance.now() - started),
      ...(sourceKind ? { sourceKind } : {}),
    };
    if (outcome === "success") {
      log.info("Template add completed", metadata);
    } else {
      log.warn("Template add did not complete", metadata);
    }
  };
}

/** A Template that declares the reserved workspace-root CLAW.md; Add removed the new agent. */
function isTemplateManifestConflict(error: unknown): error is TemplateAddMutationError {
  return error instanceof TemplateAddMutationError && error.code === "workspace_conflict";
}

/** One error-disclosure boundary for UI RPCs and the setup helper. */
export function reportTemplateAddFailure(
  error: unknown,
  operation: "plan" | "apply",
  localSource?: "local" | "upload",
): string {
  // Local project failures retain bounded diagnostics, never package content from caught errors.
  if (!localSource) {
    log.error(
      "templates.add." +
        operation +
        " failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (error instanceof TemplateProjectError && error.code === "project_invalid") {
    return `${error.message} Run openclaw templates validate <project> and correct the reported diagnostics before retrying.`;
  }
  if (operation === "apply" && isTemplateManifestConflict(error)) {
    return `${error.message} Nothing was kept. Ask the publisher to move the conflicting workspace file and publish a corrected release before adding it again.`;
  }
  if (
    error instanceof TemplatesDisabledError ||
    error instanceof ClawHubSourceError ||
    (operation === "apply" &&
      (error instanceof TemplateGatewayConsentError ||
        error instanceof TemplateSkillConsentError ||
        error instanceof TemplateGatewayPlanBlockedError ||
        error instanceof TemplateGatewayPlanChangedError))
  ) {
    return error.message;
  }
  return operation === "plan"
    ? "Template Add preview is unavailable. Review Gateway logs."
    : "Could not add this Template. Review Gateway logs before retrying.";
}

/** Uses published picker facts, never new provider discovery during Add. */
function preferredModelResolver(context: GatewayRequestHandlerOptions["context"]) {
  return (requested: string, targetAgentId: string) =>
    resolveTemplatePreferredModel(requested, async () => {
      const config = context.getRuntimeConfig();
      // Chat Add has already admitted this agent and prepared its model owner.
      // A reviewed preview has no new agent yet, so it uses the host's ambient view.
      const agentId = config.agents?.entries?.[targetAgentId]
        ? targetAgentId
        : resolveAmbientOwnerAgentId(config);
      const params = { agentId, params: { includeDetails: true }, includeManualSelection: true };
      const result = await context.readPreparedModelsList?.(params);
      return result?.models ?? [];
    });
}

/** Shared request owner: callers retain their original administrator and lifetime. */
export async function planTemplateAddForRequest(
  options: GatewayRequestHandlerOptions & {
    params: TemplatesAddPlanParams;
    onStage?: TemplateAddStageHook;
  },
): Promise<TemplateLifecyclePlanResult> {
  const { params, context, client, hasCurrentClientAuthority } = options;
  const assertLocalSourceAuthority = () => {
    if (
      "kind" in params.source &&
      (hasCurrentClientAuthority?.() === false ||
        (client &&
          (client.invalidated ||
            (client.connect.role ?? "operator") !== "operator" ||
            !client.connect.scopes?.includes(ADMIN_SCOPE))) ||
        (!client && !context.localEmbedded))
    ) {
      throw new TemplateGatewayAuthorityError(
        "Local Template preview requires current operator-admin authority.",
      );
    }
  };
  assertLocalSourceAuthority();
  assertTemplatesEnabled(context.getRuntimeConfig());
  const config = await readCurrentConfigForPolicyCheckAsync({
    configPath: resolveConfigPath(),
    env: process.env,
  });
  assertTemplatesEnabled(config);
  options.onStage?.("source_resolution_and_plan");
  const plan = await planTemplateAddForGateway({
    source: params.source,
    onStage: options.onStage,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    config,
    resolvePreferredModel: preferredModelResolver(context),
    sourceMcpServers: async () => {
      const listedMcp = await listConfiguredMcpServers();
      if (!listedMcp.ok) {
        throw new Error(listedMcp.error);
      }
      return listedMcp.authoredConfig?.mcp?.servers ?? {};
    },
  });
  assertTemplatesEnabled(context.getRuntimeConfig());
  return plan;
}

export async function applyTemplateAddForRequest(
  options: GatewayRequestHandlerOptions & {
    params: TemplatesAddApplyParams;
    onStage?: TemplateAddStageHook;
  },
): Promise<GatewayTemplateAddApplyResult> {
  const { context, client, signal, sessionMutationCommitGuard, hasCurrentClientAuthority } =
    options;
  // The handler option type also carries an open record; name the union so `mode` narrows.
  const params: TemplatesAddApplyParams = options.params;
  const configPath = resolveConfigPath();
  const configEnv = process.env;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    sessionMutationCommitGuard?.();
  };
  assertTemplatesEnabled(context.getRuntimeConfig());
  assertTemplatesEnabled(
    await readCurrentConfigForPolicyCheckAsync({ configPath, env: configEnv }),
  );
  assertCurrent();
  const applyRuntime = context.applyPluginLifecycleChange;
  const reloadPlugins: PluginInstallBatchReload | undefined = applyRuntime
    ? async (plugins, reloadOptions) => {
        const assertForwardCurrent = () => {
          assertCurrent();
          reloadOptions?.commitGuard?.();
        };
        assertForwardCurrent();
        const { application } = await reloadManagedPlugin({
          plugins: [...plugins],
          applyRuntime,
          beforePersistentApply: assertForwardCurrent,
          ...(signal ? { signal } : {}),
        });
        if (!application) {
          throw new Error("Gateway did not confirm plugin runtime activation.");
        }
        return application;
      }
    : undefined;
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  const admissionApplication = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  const assertRetainedRuntime = (agent: { agentId: string; config: AgentEntryConfig }) => {
    assertCurrent();
    if (
      !isDeepStrictEqual(context.getRuntimeConfig().agents?.entries?.[agent.agentId], agent.config)
    ) {
      throw new Error(
        "The retained Template agent configuration is not active in this Gateway; wait for runtime recovery before retrying.",
      );
    }
  };
  const publishProgress = (
    stage: "agent-admitted" | "agent-ready",
    agent: { agentId: string; sessionKey: string },
  ) => {
    if (options.client?.connId) {
      context.broadcastToConnIds(
        "templates.add.progress",
        { requestId: options.req.id, stage, ...agent },
        new Set([options.client.connId]),
      );
    }
  };
  options.onStage?.("apply");
  const result = await withTemplateAddTimings(
    options.req.id,
    async () =>
      await applyTemplateAddForGateway({
        onStage: options.onStage,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
        ...("mode" in params
          ? {
              mode: params.mode,
              source: params.source,
              ...(params.resume ? { resume: true as const } : {}),
              // Creation has finished: the first turn starts now, with its outcome, and
              // nothing was installed here that needs an installer card in the chat.
              onAgentCreated: async (agent, report, dependenciesPending, onModelRequested) => {
                assertCurrent();
                await measureTemplateAddStage(
                  "opening.total",
                  async () =>
                    await startAgentOnboardingConversation(
                      options,
                      agent.agentId,
                      agent.sessionKey,
                      "template",
                      buildTemplateOpeningMessage(report, agent, dependenciesPending),
                      () => {
                        assertCurrent();
                        publishProgress("agent-ready", agent);
                      },
                      onModelRequested,
                    ),
                );
              },
              onDependenciesSettled: async (agent, report) => {
                assertCurrent();
                await measureTemplateAddStage(
                  "dependencies.report",
                  async () => await startTemplateDependencyConversation(options, agent, report),
                );
              },
            }
          : {
              source: params.source,
              planIntegrity: params.planIntegrity,
              ...(params.acknowledgeCapabilities
                ? { acknowledgeCapabilities: params.acknowledgeCapabilities }
                : {}),
              ...(params.acknowledgeSkillWarnings
                ? { acknowledgeSkillWarnings: params.acknowledgeSkillWarnings }
                : {}),
              onAgentReady: async (agent) => {
                assertCurrent();
                publishProgress("agent-ready", agent);
                await startAgentOnboardingConversation(
                  options,
                  agent.agentId,
                  agent.sessionKey,
                  "template",
                );
              },
              onSetupEvent: async (event) => {
                assertCurrent();
                await publishTemplateInstallEvent(options.context, event, assertCurrent);
                assertCurrent();
              },
            }),
        getPlanningContext: async () => {
          assertCurrent();
          const config = await readCurrentConfigForPolicyCheckAsync({
            configPath,
            env: configEnv,
          });
          assertCurrent();
          assertTemplatesEnabled(config);
          return {
            config,
            resolvePreferredModel: preferredModelResolver(context),
            sourceMcpServers: async () => {
              const listedMcp = await listConfiguredMcpServers();
              assertCurrent();
              if (!listedMcp.ok) {
                throw new Error(listedMcp.error);
              }
              return listedMcp.authoredConfig?.mcp?.servers ?? {};
            },
          };
        },
        policyConfig: { configPath, env: configEnv },
        assertCurrent,
        ...(signal ? { signal } : {}),
        ...(reloadPlugins ? { reloadPlugins } : {}),
        configWriteOptions: attachRuntimeConfigWriteApplication({}, application),
        admissionConfigWriteOptions: attachRuntimeConfigWriteApplication({}, admissionApplication),
        waitForAdmissionRuntime: async (retainedAgent) => {
          if (retainedAgent) {
            assertRetainedRuntime(retainedAgent);
            return "applied";
          }
          const outcome = admissionApplication.claimed
            ? await admissionApplication.result
            : "unclaimed";
          if (outcome !== "applied" && outcome !== "applied-restart-required") {
            throw new Error(
              "Ordinary agent admission was saved but runtime application was not confirmed (" +
                (typeof outcome === "string" ? outcome : JSON.stringify(outcome)) +
                "); inspect config.get before retrying.",
            );
          }
          return outcome;
        },
        onAgentAdmitted: async (agent) => {
          assertCurrent();
          publishProgress("agent-admitted", agent);
        },
        waitForAgentRuntime: async (retainedAgent) => {
          if (retainedAgent) {
            assertRetainedRuntime(retainedAgent);
            return "applied";
          }
          const outcome = application.claimed ? await application.result : "unclaimed";
          // Report publication before the caller rechecks authority: an already exposed
          // ordinary agent must be retained even when installation authority expires.
          if (outcome !== "applied" && outcome !== "applied-restart-required") {
            throw new Error(
              `Template agent configuration was saved but its application to the active Gateway was not confirmed (${typeof outcome === "string" ? outcome : JSON.stringify(outcome)}); inspect config.get before retrying.`,
            );
          }
          return outcome;
        },
        prepareAgentChat: async (agentId, config, pending) => {
          assertCurrent();
          const onboarding = await measureTemplateAddStage(
            "session.prepare",
            async () =>
              await completeAgentOnboarding(options, agentId, {
                config,
                ...pending,
              }),
          );
          if (onboarding.preparationUncertain) {
            throw new TemplateAddMutationError(
              "agent_session_outcome_uncertain",
              onboarding.status === "error"
                ? onboarding.error
                : "Ordinary session preparation outcome is uncertain",
            );
          }
          if (onboarding.status !== "completed" || !onboarding.rollback) {
            throw new Error(
              onboarding.status === "error"
                ? onboarding.error
                : "The agent's conversation could not be saved.",
            );
          }
          return onboarding.rollback;
        },
        cronGateway: createTemplateCronGateway(
          context.cron,
          context.getRuntimeConfig,
          assertCurrent,
          (job, cfg) =>
            captureCronCreatorSession(
              job,
              undefined,
              {
                client,
                context,
                signal,
                hasCurrentClientAuthority,
                ...(client ? { captureIndependentOperatorSource: true as const } : {}),
              },
              cfg,
            ),
        ),
        rollbackNewAgent: async (
          agentId: string,
          expectedAgentConfig: TemplateAddPlan["agent"]["config"],
          expectedCronJobs: PersistedTemplateCronRef[],
        ) => {
          assertCurrent();
          const createdJobsById = new Map(
            expectedCronJobs.flatMap((job) =>
              job.schedulerJobId ? [[job.schedulerJobId, job] as const] : [],
            ),
          );
          const liveJobs = (await context.cron.list({ includeDisabled: true })).filter(
            (job) => job.agentId === agentId,
          );
          for (const job of liveJobs) {
            const created = createdJobsById.get(job.id);
            if (!created || !templateCronGatewayJobMatchesRef(agentId, created, job)) {
              throw new Error(
                "Agent automations changed during Template Add; rollback left it intact.",
              );
            }
          }
          await context.cron.removeAgentJobsTransactional(agentId, async () => {
            assertCurrent();
            await deleteAgentConfigEntry({
              agentId,
              assertCurrent,
              validate: (agent) => {
                if (!isDeepStrictEqual(agent, expectedAgentConfig)) {
                  throw new Error(
                    "New agent changed during Template Add; rollback left it intact.",
                  );
                }
              },
            });
          });
        },
      }),
  );
  return result;
}

export const templatesAddHandlers: GatewayRequestHandlers = {
  "templates.add.plan": async (options) => {
    const { params, respond } = options;
    const diagnostic = templateAddDiagnostic("plan");
    let stage: "policy" | TemplateAddDiagnosticStage = "policy";
    if (!assertValidParams(params, validateTemplatesAddPlanParams, "templates.add.plan", respond)) {
      diagnostic("params", "invalid_params");
      return;
    }
    try {
      const result = await planTemplateAddForRequest({
        ...options,
        params,
        onStage: (next) => {
          stage = next;
        },
      });
      diagnostic(stage, "success", "kind" in params.source ? params.source.kind : "clawhub");
      respond(true, result);
    } catch (error) {
      // A preview never mutates state; say so, or owner-routed CLIs report a possible partial Add.
      const noEffect = { details: { mutationAccepted: false } };
      if (
        error instanceof TemplatesDisabledError ||
        error instanceof TemplateGatewayAuthorityError
      ) {
        diagnostic(stage, "forbidden", "kind" in params.source ? params.source.kind : "clawhub");
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message, noEffect));
        return;
      }
      diagnostic(stage, "failed", "kind" in params.source ? params.source.kind : "clawhub");
      const message = reportTemplateAddFailure(
        error,
        "plan",
        "kind" in params.source ? params.source.kind : undefined,
      );
      respond(
        false,
        undefined,
        errorShape(
          error instanceof TemplateProjectError && error.code === "project_invalid"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          message,
          noEffect,
        ),
      );
    }
  },
  "templates.add.apply": async (options) => {
    const { params, respond } = options;
    const diagnostic = templateAddDiagnostic("apply");
    let stage: "policy" | TemplateAddDiagnosticStage = "policy";
    if (
      !assertValidParams(params, validateTemplatesAddApplyParams, "templates.add.apply", respond)
    ) {
      diagnostic("params", "invalid_params");
      return;
    }
    try {
      const result = await applyTemplateAddForRequest({
        ...options,
        params,
        onStage: (next) => {
          stage = next;
        },
      });
      diagnostic(
        stage,
        result.status === "complete" ? "success" : "partial",
        "kind" in params.source ? params.source.kind : "clawhub",
      );
      respond(true, result);
    } catch (error) {
      const message = reportTemplateAddFailure(
        error,
        "apply",
        "kind" in params.source ? params.source.kind : undefined,
      );
      const code =
        error instanceof TemplatesDisabledError
          ? ErrorCodes.FORBIDDEN
          : (error instanceof TemplateProjectError && error.code === "project_invalid") ||
              error instanceof TemplateGatewayPlanChangedError ||
              error instanceof TemplateGatewayPlanBlockedError ||
              error instanceof TemplateGatewayConsentError ||
              error instanceof TemplateSkillConsentError ||
              isTemplateManifestConflict(error) ||
              (error instanceof ClawHubSourceError &&
                error.code === "clawhub_risk_acknowledgement_required")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      diagnostic(
        stage,
        code === ErrorCodes.FORBIDDEN ? "forbidden" : "failed",
        "kind" in params.source ? params.source.kind : "clawhub",
      );
      respond(
        false,
        undefined,
        errorShape(
          code,
          message,
          error instanceof ClawHubSourceError &&
            error.code === "clawhub_risk_acknowledgement_required"
            ? {
                details: {
                  code: GatewayErrorDetailCodes.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
                  warning: error.warning?.trim() || error.message,
                },
              }
            : error instanceof TemplateGatewayConsentError ||
                error instanceof TemplateSkillConsentError
              ? {
                  details: {
                    code: GatewayErrorDetailCodes.TEMPLATE_REVIEW_REQUIRED,
                    kind: error instanceof TemplateGatewayConsentError ? "plugin" : "skill",
                  },
                }
              : undefined,
        ),
      );
    }
  },
};

class TemplateGatewayAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGatewayAuthorityError";
  }
}
