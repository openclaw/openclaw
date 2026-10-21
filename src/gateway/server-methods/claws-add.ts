import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { clawCronGatewayJobMatchesRef, type PersistedClawCronRef } from "../../claws/cron.js";
import {
  applyClawAddForGateway,
  ClawGatewayPlanBlockedError,
  ClawGatewayPlanChangedError,
} from "../../claws/gateway-add-apply.js";
import { planClawAddForGateway } from "../../claws/gateway-add-plan.js";
import { ClawGatewayConsentError } from "../../claws/gateway-plugin-consent.js";
import { ClawSkillConsentError } from "../../claws/gateway-skill-consent.js";
import { assertClawsLabsEnabled, ClawsLabsDisabledError } from "../../claws/labs-gate.js";
import type { ClawAddPlan } from "../../claws/types.js";
import { readCurrentConfigForPolicyCheckAsync } from "../../config/io.runtime.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import { resolveConfigPath } from "../../config/paths.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../../plugins/install-runtime-batch.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { deleteAgentConfigEntry } from "./agents-config-mutations.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/claws-add");

export const clawsAddHandlers: GatewayRequestHandlers = {
  "claws.add.plan": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateClawsAddPlanParams, "claws.add.plan", respond)) {
      return;
    }
    try {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const config = await readCurrentConfigForPolicyCheckAsync({
        configPath: resolveConfigPath(),
        env: process.env,
      });
      assertClawsLabsEnabled(config);
      const listedMcp = await listConfiguredMcpServers();
      if (!listedMcp.ok) {
        throw new Error(listedMcp.error);
      }
      const plan = await planClawAddForGateway({
        source: params.source,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        config,
        sourceMcpServers: listedMcp.mcpServers,
      });
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, plan);
    } catch (error) {
      if (error instanceof ClawsLabsDisabledError) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
        return;
      }
      log.error(`claws.add.plan failed: ${error instanceof Error ? error.message : String(error)}`);
      const message =
        error instanceof ClawHubSourceError
          ? error.message
          : "Claw Add preview is unavailable. Review Gateway logs.";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "claws.add.apply": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    if (!assertValidParams(params, validateClawsAddApplyParams, "claws.add.apply", respond)) {
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
        throw new ClawGatewayAuthorityError("Claw installation authority is no longer active.");
      }
    };
    try {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      assertClawsLabsEnabled(
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
      const result = await applyClawAddForGateway({
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
          assertClawsLabsEnabled(config);
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
              `Claw agent configuration was saved but its application to the active Gateway was not confirmed (${outcome}); inspect config.get before retrying.`,
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
              throw new Error("Claw schedule declaration is invalid.");
            }
            await assertValidCronCreateDelivery(context.getRuntimeConfig(), normalized);
            assertForwardCurrent();
            return await context.cron.add(normalized, {
              commitGuard: assertForwardCurrent,
              matchesExisting: (job) => {
                if (job.declarationKey === normalized.declarationKey) {
                  throw new Error("Claw schedule declaration appeared after the list check.");
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
            return await context.cron.readJob(jobId);
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
          expectedAgentConfig: ClawAddPlan["agent"]["config"],
          expectedCronJobs: PersistedClawCronRef[],
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
            if (!created || !clawCronGatewayJobMatchesRef(agentId, created, job)) {
              throw new Error(
                "Agent automations changed during Claw Add; rollback left it intact.",
              );
            }
          }
          await context.cron.removeAgentJobsTransactional(agentId, async () => {
            assertCurrent();
            await deleteAgentConfigEntry({
              agentId,
              allowConfigSizeDrop: true,
              assertCurrent,
              validate: (agent) => {
                if (!isDeepStrictEqual(agent, expectedAgentConfig)) {
                  throw new Error("New agent changed during Claw Add; rollback left it intact.");
                }
              },
            });
          });
        },
      });
      respond(true, result);
    } catch (error) {
      log.error(
        `claws.add.apply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code =
        error instanceof ClawGatewayAuthorityError || error instanceof ClawsLabsDisabledError
          ? ErrorCodes.FORBIDDEN
          : error instanceof ClawGatewayPlanChangedError ||
              error instanceof ClawGatewayPlanBlockedError ||
              error instanceof ClawGatewayConsentError ||
              error instanceof ClawSkillConsentError ||
              (error instanceof ClawHubSourceError &&
                error.code === "clawhub_risk_acknowledgement_required")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      const message =
        error instanceof ClawGatewayAuthorityError ||
        error instanceof ClawsLabsDisabledError ||
        error instanceof ClawGatewayConsentError ||
        error instanceof ClawSkillConsentError ||
        error instanceof ClawGatewayPlanBlockedError ||
        error instanceof ClawGatewayPlanChangedError ||
        error instanceof ClawHubSourceError
          ? error.message
          : "Could not add this Claw. Review Gateway logs before retrying.";
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
            : error instanceof ClawGatewayConsentError || error instanceof ClawSkillConsentError
              ? {
                  details: {
                    code: GatewayErrorDetailCodes.CLAW_REVIEW_REQUIRED,
                    kind: error instanceof ClawGatewayConsentError ? "plugin" : "skill",
                  },
                }
              : undefined,
        ),
      );
    }
  },
};

class ClawGatewayAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawGatewayAuthorityError";
  }
}
