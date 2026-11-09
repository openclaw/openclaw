import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateTemplatesAddApplyParams,
  validateTemplatesAddPlanParams,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readCurrentConfigForPolicyCheckAsync } from "../../config/io.runtime.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import { resolveConfigPath } from "../../config/paths.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../../plugins/install-runtime-batch.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
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
import type { TemplateAddDiagnosticStage } from "../../templates/gateway-add-source.js";
import { TemplateGatewayConsentError } from "../../templates/gateway-plugin-consent.js";
import { TemplateSkillConsentError } from "../../templates/gateway-skill-consent.js";
import {
  assertTemplatesLabsEnabled,
  TemplatesLabsDisabledError,
} from "../../templates/labs-gate.js";
import type { TemplateAddPlan } from "../../templates/types.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";
import type { GatewayRequestHandlers } from "./types.js";
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

export const templatesAddHandlers: GatewayRequestHandlers = {
  "templates.add.plan": async ({ params, respond, context, client, hasCurrentClientAuthority }) => {
    const diagnostic = templateAddDiagnostic("plan");
    if (!assertValidParams(params, validateTemplatesAddPlanParams, "templates.add.plan", respond)) {
      diagnostic("params", "invalid_params");
      return;
    }
    const sourceKind = "kind" in params.source ? params.source.kind : "clawhub";
    let stage: "policy" | TemplateAddDiagnosticStage = "policy";
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
    try {
      assertLocalSourceAuthority();
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      const config = await readCurrentConfigForPolicyCheckAsync({
        configPath: resolveConfigPath(),
        env: process.env,
      });
      assertTemplatesLabsEnabled(config);
      const listedMcp = await listConfiguredMcpServers();
      if (!listedMcp.ok) {
        throw new Error(listedMcp.error);
      }
      stage = "source_resolution_and_plan";
      const plan = await planTemplateAddForGateway({
        source: params.source,
        onStage: (nextStage) => {
          stage = nextStage;
        },
        ...(params.agentId ? { agentId: params.agentId } : {}),
        config,
        sourceMcpServers: listedMcp.mcpServers,
      });
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      assertLocalSourceAuthority();
      diagnostic(stage, "success", sourceKind);
      respond(true, plan);
    } catch (error) {
      if (
        error instanceof TemplatesLabsDisabledError ||
        error instanceof TemplateGatewayAuthorityError
      ) {
        diagnostic(stage, "forbidden", sourceKind);
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
        return;
      }
      diagnostic(stage, "failed", sourceKind);
      const message =
        error instanceof ClawHubSourceError
          ? error.message
          : "Template Add preview is unavailable. Review Gateway logs.";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "templates.add.apply": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    const diagnostic = templateAddDiagnostic("apply");
    if (
      !assertValidParams(params, validateTemplatesAddApplyParams, "templates.add.apply", respond)
    ) {
      diagnostic("params", "invalid_params");
      return;
    }
    const sourceKind = "kind" in params.source ? params.source.kind : "clawhub";
    let stage: "policy" | TemplateAddDiagnosticStage = "policy";
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
        ? async (plugins, options) => {
            const assertForwardCurrent = () => {
              assertCurrent();
              options?.commitGuard?.();
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
      stage = "apply";
      const result = await applyTemplateAddForGateway({
        source: params.source,
        onStage: (nextStage) => {
          stage = nextStage;
        },
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
          const listedMcp = await listConfiguredMcpServers();
          assertCurrent();
          if (!listedMcp.ok) {
            throw new Error(listedMcp.error);
          }
          return {
            config,
            sourceMcpServers: listedMcp.mcpServers,
          };
        },
        policyConfig: { configPath, env: configEnv },
        assertCurrent,
        ...(signal ? { signal } : {}),
        ...(reloadPlugins ? { reloadPlugins } : {}),
        configWriteOptions: attachRuntimeConfigWriteApplication({}, application),
        waitForAgentRuntime: async () => {
          const outcome = application.claimed ? await application.result : "unclaimed";
          assertCurrent();
          if (outcome !== "applied") {
            throw new Error(
              `Template agent configuration was saved but its application to the active Gateway was not confirmed (${outcome}); inspect config.get before retrying.`,
            );
          }
        },
        cronGateway: {
          add: async (input, options) => {
            const assertForwardCurrent = () => {
              assertCurrent();
              options?.commitGuard?.();
            };
            assertCurrent();
            const normalized = normalizeCronJobCreate(input);
            if (!normalized || !validateCronAddParams(normalized)) {
              throw new Error("Template schedule declaration is invalid.");
            }
            await assertValidCronCreateDelivery(context.getRuntimeConfig(), normalized);
            assertForwardCurrent();
            return await context.cron.add(normalized, {
              commitGuard: assertForwardCurrent,
              matchesExisting: (job) => {
                if (job.declarationKey === normalized.declarationKey) {
                  throw new Error("Template schedule declaration appeared after the list check.");
                }
                return false;
              },
            });
          },
          list: async (agentId) => ({
            jobs: (await context.cron.list({ includeDisabled: true })).filter(
              (job) => job.agentId === agentId,
            ),
          }),
          get: async (jobId) => {
            assertCurrent();
            const job = await context.cron.readJob(jobId);
            return job ? { ...job, configRevision: resolveCronJobConfigRevision(job) } : undefined;
          },
          writeScratch: async (jobId, content, commitGuard) => {
            const scratchResult = await context.cron.writeScratch(jobId, {
              content,
              expectedRevision: 0,
              commitGuard: () => {
                assertCurrent();
                commitGuard();
              },
            });
            if (!scratchResult.ok) {
              throw new Error("Template automation scratch changed before import.");
            }
          },
          enable: async (jobId, expectedConfigRevision, commitGuard) => {
            await context.cron.updateWithPrecondition(
              jobId,
              { enabled: true },
              (job) => {
                const actual = resolveCronJobConfigRevision(job);
                if (actual !== expectedConfigRevision) {
                  throw new CronJobConfigRevisionConflictError(expectedConfigRevision, actual);
                }
              },
              {
                commitGuard: () => {
                  assertCurrent();
                  commitGuard();
                },
              },
            );
          },
          remove: async (jobId, options) => {
            const assertForwardCurrent = () => {
              assertCurrent();
              options.commitGuard?.();
            };
            assertForwardCurrent();
            return await context.cron.remove(jobId, {
              commitGuard: assertForwardCurrent,
              expectedConfigRevision: options.expectedConfigRevision,
            });
          },
        },
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
      diagnostic(stage, result.status === "complete" ? "success" : "partial", sourceKind);
      respond(true, result);
    } catch (error) {
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
      diagnostic(stage, code === ErrorCodes.FORBIDDEN ? "forbidden" : "failed", sourceKind);
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
