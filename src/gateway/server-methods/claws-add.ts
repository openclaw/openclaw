import {
  ErrorCodes,
  errorShape,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import {
  applyClawAddForGateway,
  ClawGatewayPlanChangedError,
} from "../../claws/gateway-add-apply.js";
import { planClawAddForGateway } from "../../claws/gateway-add-plan.js";
import { ClawGatewayConsentError } from "../../claws/gateway-plugin-consent.js";
import { ClawSkillConsentError } from "../../claws/gateway-skill-consent.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../../plugins/install-runtime-batch.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/claws-add");

export const clawsAddHandlers: GatewayRequestHandlers = {
  "claws.add.plan": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateClawsAddPlanParams, "claws.add.plan", respond)) {
      return;
    }
    const config = context.getRuntimeConfig();
    try {
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
      respond(true, plan);
    } catch (error) {
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
      assertCurrent();
      const applyRuntime = context.applyPluginLifecycleChange;
      const reloadPlugins: PluginInstallBatchReload | undefined = applyRuntime
        ? async (plugins) => {
            assertCurrent();
            const { application } = await reloadManagedPlugin({
              plugins: [...plugins],
              applyRuntime,
              beforePersistentApply: assertCurrent,
              ...(signal ? { signal } : {}),
            });
            if (!application) {
              throw new Error("Gateway did not confirm plugin runtime activation.");
            }
            return application;
          }
        : undefined;
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
          const listedMcp = await listConfiguredMcpServers();
          assertCurrent();
          if (!listedMcp.ok) {
            throw new Error(listedMcp.error);
          }
          return {
            config: context.getRuntimeConfig(),
            sourceMcpServers: listedMcp.mcpServers,
          };
        },
        assertCurrent,
        ...(signal ? { signal } : {}),
        ...(reloadPlugins ? { reloadPlugins } : {}),
        cronGateway: {
          add: async (input) => {
            assertCurrent();
            const normalized = normalizeCronJobCreate(input);
            if (!normalized || !validateCronAddParams(normalized)) {
              throw new Error("Claw schedule declaration is invalid.");
            }
            await assertValidCronCreateDelivery(context.getRuntimeConfig(), normalized);
            assertCurrent();
            return await context.cron.add(normalized, {
              commitGuard: assertCurrent,
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
        },
      });
      respond(true, result);
    } catch (error) {
      log.error(
        `claws.add.apply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code =
        error instanceof ClawGatewayAuthorityError
          ? ErrorCodes.FORBIDDEN
          : error instanceof ClawGatewayPlanChangedError ||
              error instanceof ClawGatewayConsentError ||
              error instanceof ClawSkillConsentError ||
              (error instanceof ClawHubSourceError &&
                error.code === "clawhub_risk_acknowledgement_required")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      const message =
        error instanceof ClawGatewayAuthorityError ||
        error instanceof ClawGatewayConsentError ||
        error instanceof ClawSkillConsentError ||
        error instanceof ClawGatewayPlanChangedError ||
        error instanceof ClawHubSourceError
          ? error.message
          : "Claw installation is unavailable. Review Claws status before retrying.";
      respond(false, undefined, errorShape(code, message));
    }
  },
};

class ClawGatewayAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawGatewayAuthorityError";
  }
}
