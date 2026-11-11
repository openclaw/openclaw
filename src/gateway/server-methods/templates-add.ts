import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateTemplatesAddApplyParams,
  validateTemplatesAddPlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
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
import { TemplateGatewayConsentError } from "../../templates/gateway-plugin-consent.js";
import { TemplateSkillConsentError } from "../../templates/gateway-skill-consent.js";
import {
  assertTemplatesLabsEnabled,
  TemplatesLabsDisabledError,
} from "../../templates/labs-gate.js";
import type { TemplateAddPlan } from "../../templates/types.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";
import { completeAgentOnboarding, startAgentOnboardingConversation } from "./agents-onboarding.js";
import { publishTemplateInstallEvent } from "./templates-add-conversation.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/templates-add");

export const templatesAddHandlers: GatewayRequestHandlers = {
  "templates.add.plan": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTemplatesAddPlanParams, "templates.add.plan", respond)) {
      return;
    }
    try {
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      const config = await readCurrentConfigForPolicyCheckAsync({
        configPath: resolveConfigPath(),
        env: process.env,
      });
      assertTemplatesLabsEnabled(config);
      const plan = await planTemplateAddForGateway({
        source: params.source,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        config,
        sourceMcpServers: async () => {
          const listedMcp = await listConfiguredMcpServers();
          if (!listedMcp.ok) {
            throw new Error(listedMcp.error);
          }
          return listedMcp.mcpServers;
        },
      });
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      respond(true, plan);
    } catch (error) {
      if (error instanceof TemplatesLabsDisabledError) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
        return;
      }
      log.error(
        `templates.add.plan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const message =
        error instanceof ClawHubSourceError
          ? error.message
          : "Template Add preview is unavailable. Review Gateway logs.";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "templates.add.apply": async (options) => {
    const {
      params,
      respond,
      context,
      client,
      signal,
      sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    } = options;
    if (
      !assertValidParams(params, validateTemplatesAddApplyParams, "templates.add.apply", respond)
    ) {
      return;
    }
    const configPath = resolveConfigPath();
    const configEnv = process.env;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      sessionMutationCommitGuard?.();
      if (
        hasCurrentClientAuthority?.() === false ||
        (client &&
          (client.invalidated ||
            (client.connect.role ?? "operator") !== "operator" ||
            !client.connect.scopes?.includes(ADMIN_SCOPE))) ||
        (!client && !context.localEmbedded)
      ) {
        throw new TemplateGatewayAuthorityError(
          "Template installation authority is no longer active.",
        );
      }
    };
    try {
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      assertTemplatesLabsEnabled(
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
          !isDeepStrictEqual(
            context.getRuntimeConfig().agents?.entries?.[agent.agentId],
            agent.config,
          )
        ) {
          throw new Error(
            "The retained Template agent configuration is not active in this Gateway; wait for runtime recovery before retrying.",
          );
        }
      };
      const result = await applyTemplateAddForGateway({
        source: params.source,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        planIntegrity: params.planIntegrity,
        ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
        ...(params.acknowledgeCapabilities
          ? { acknowledgeCapabilities: params.acknowledgeCapabilities }
          : {}),
        ...(params.acknowledgeSkillWarnings
          ? { acknowledgeSkillWarnings: params.acknowledgeSkillWarnings }
          : {}),
        getPlanningContext: async () => {
          assertCurrent();
          const config = await readCurrentConfigForPolicyCheckAsync({
            configPath,
            env: configEnv,
          });
          assertCurrent();
          assertTemplatesLabsEnabled(config);
          return {
            config,
            sourceMcpServers: async () => {
              const listedMcp = await listConfiguredMcpServers();
              assertCurrent();
              if (!listedMcp.ok) {
                throw new Error(listedMcp.error);
              }
              return listedMcp.mcpServers;
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
        onAgentAdmitted: async ({ agentId, sessionKey }) => {
          assertCurrent();
          if (options.client?.connId) {
            context.broadcastToConnIds(
              "templates.add.progress",
              {
                requestId: options.req.id,
                stage: "agent-admitted",
                agentId,
                sessionKey,
              },
              new Set([options.client.connId]),
            );
          }
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
        onAgentReady: async ({ agentId, sessionKey }) => {
          assertCurrent();
          if (options.client?.connId) {
            context.broadcastToConnIds(
              "templates.add.progress",
              {
                requestId: options.req.id,
                stage: "agent-ready",
                agentId,
                sessionKey,
              },
              new Set([options.client.connId]),
            );
          }
          await startAgentOnboardingConversation(options, agentId, sessionKey, "template");
        },
        onSetupEvent: async (event) => {
          assertCurrent();
          await publishTemplateInstallEvent(options.context, event, assertCurrent);
          assertCurrent();
        },
        prepareAgentChat: async (agentId, config, pending) => {
          assertCurrent();
          const onboarding = await completeAgentOnboarding(options, agentId, {
            config,
            ...pending,
          });
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
      });
      respond(true, result);
    } catch (error) {
      log.error(
        `templates.add.apply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code =
        error instanceof TemplateGatewayAuthorityError ||
        error instanceof TemplatesLabsDisabledError
          ? ErrorCodes.FORBIDDEN
          : error instanceof TemplateGatewayPlanChangedError ||
              error instanceof TemplateGatewayPlanBlockedError ||
              error instanceof TemplateGatewayConsentError ||
              error instanceof TemplateSkillConsentError ||
              (error instanceof ClawHubSourceError &&
                error.code === "clawhub_risk_acknowledgement_required")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      const message =
        error instanceof TemplateGatewayAuthorityError ||
        error instanceof TemplatesLabsDisabledError ||
        error instanceof TemplateGatewayConsentError ||
        error instanceof TemplateSkillConsentError ||
        error instanceof TemplateGatewayPlanBlockedError ||
        error instanceof TemplateGatewayPlanChangedError ||
        error instanceof ClawHubSourceError
          ? error.message
          : "Could not add this Template. Review Gateway logs before retrying.";
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
