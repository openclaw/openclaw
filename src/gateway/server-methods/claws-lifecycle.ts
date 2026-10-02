import {
  ErrorCodes,
  errorShape,
  validateClawsRemoveApplyParams,
  validateClawsUpdateApplyParams,
  validateClawsRemovePlanParams,
  validateClawsUpdatePlanParams,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { ClawCronAddRejectedError } from "../../claws/cron-update.js";
import { clawCronGatewayJobMatchesRef } from "../../claws/cron.js";
import { ClawGatewayPlanChangedError } from "../../claws/gateway-add-apply.js";
import {
  ClawGatewayPlanError,
  planClawRemoveForGateway,
  planClawUpdateForGateway,
} from "../../claws/gateway-lifecycle-plan.js";
import { ClawGatewayConsentError } from "../../claws/gateway-plugin-consent.js";
import { applyClawRemoveForGateway } from "../../claws/gateway-remove-apply.js";
import { ClawSkillConsentError } from "../../claws/gateway-skill-consent.js";
import { applyClawUpdateForGateway } from "../../claws/gateway-update-apply.js";
import { readCurrentConfigForPolicyCheck } from "../../config/io.js";
import { resolveConfigPath } from "../../config/paths.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../../plugins/install-runtime-batch.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { createServingClawMonitorCleanupGateway } from "../server-claws-monitor-adapter.js";
import { createServingClawPackageRemovalGateway } from "../server-claws-package-removal-adapter.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/claws-lifecycle");

function respondPlanError(error: unknown, respond: RespondFn): void {
  log.error(
    `Claw lifecycle preview failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (error instanceof ClawGatewayPlanError) {
    const code =
      error.code === "claw_not_found" || error.code === "claw_update_source_mismatch"
        ? ErrorCodes.INVALID_REQUEST
        : ErrorCodes.UNAVAILABLE;
    respond(false, undefined, errorShape(code, error.message));
    return;
  }
  const message =
    error instanceof ClawHubSourceError
      ? error.message
      : "Claw lifecycle preview is unavailable. Review Gateway logs.";
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

export const clawsLifecycleHandlers: GatewayRequestHandlers = {
  "claws.update.plan": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateClawsUpdatePlanParams, "claws.update.plan", respond)) {
      return;
    }
    try {
      const plan = await planClawUpdateForGateway({
        agentId: params.agentId,
        source: params.source,
        config: context.getRuntimeConfig(),
      });
      respond(true, plan);
    } catch (error) {
      respondPlanError(error, respond);
    }
  },
  "claws.update.apply": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    if (!assertValidParams(params, validateClawsUpdateApplyParams, "claws.update.apply", respond)) {
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
        throw new ClawGatewayAuthorityError("Claw update authority is no longer active.");
      }
    };
    try {
      assertCurrent();
      const configPath = resolveConfigPath();
      const configEnv = process.env;
      const applyRuntime = context.applyPluginLifecycleChange;
      const reloadPlugins: PluginInstallBatchReload | undefined = applyRuntime
        ? async (plugins, options) => {
            assertCurrent();
            const { application } = await reloadManagedPlugin({
              plugins: [...plugins],
              applyRuntime,
              beforePersistentApply: () => {
                assertCurrent();
                options?.commitGuard?.();
              },
              ...(signal ? { signal } : {}),
            });
            if (!application) {
              throw new Error("Gateway did not confirm plugin runtime activation.");
            }
            return application;
          }
        : undefined;
      const result = await applyClawUpdateForGateway({
        agentId: params.agentId,
        source: params.source,
        planIntegrity: params.planIntegrity,
        ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
        ...(params.acknowledgeCapabilities
          ? { acknowledgeCapabilities: params.acknowledgeCapabilities }
          : {}),
        ...(params.acknowledgeSkillWarnings
          ? { acknowledgeSkillWarnings: params.acknowledgeSkillWarnings }
          : {}),
        getRuntimeConfig: () => readCurrentConfigForPolicyCheck({ configPath, env: configEnv }),
        assertCurrent,
        ...(signal ? { signal } : {}),
        ...(reloadPlugins ? { reloadPlugins } : {}),
        cronGateway: {
          add: async (input, options) => {
            assertCurrent();
            const normalized = normalizeCronJobCreate(input);
            if (!normalized || !validateCronAddParams(normalized)) {
              throw new ClawCronAddRejectedError("Claw schedule declaration is invalid.");
            }
            try {
              await assertValidCronCreateDelivery(context.getRuntimeConfig(), normalized);
            } catch (error) {
              throw new ClawCronAddRejectedError(
                error instanceof Error ? error.message : String(error),
              );
            }
            assertCurrent();
            options?.commitGuard?.();
            return await context.cron.add(normalized, {
              commitGuard: () => {
                assertCurrent();
                options?.commitGuard?.();
              },
              matchesExisting: (job) => {
                if (job.declarationKey !== normalized.declarationKey) {
                  return false;
                }
                const existingRef = options?.existingRef;
                if (
                  existingRef?.status === "complete" &&
                  existingRef.agentId === params.agentId &&
                  existingRef.declarationKey === normalized.declarationKey &&
                  existingRef.schedulerJobId === job.id &&
                  clawCronGatewayJobMatchesRef(params.agentId, existingRef, job)
                ) {
                  return true;
                }
                throw new ClawCronAddRejectedError(
                  "Claw schedule declaration is already in use.",
                  "collision",
                );
              },
            });
          },
          get: async (schedulerJobId) => {
            assertCurrent();
            const job = await context.cron.readJob(schedulerJobId);
            assertCurrent();
            return job;
          },
          list: async (agentId) => ({
            jobs: (await context.cron.list({ includeDisabled: true })).filter(
              (job) => job.agentId === agentId,
            ),
          }),
          remove: async (schedulerJobId, options) => {
            assertCurrent();
            return await context.cron.remove(schedulerJobId, {
              commitGuard: () => {
                assertCurrent();
                options?.commitGuard?.();
              },
            });
          },
        },
      });
      respond(true, result);
    } catch (error) {
      log.error(
        `claws.update.apply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const code =
        error instanceof ClawGatewayAuthorityError
          ? ErrorCodes.FORBIDDEN
          : error instanceof ClawGatewayPlanChangedError ||
              error instanceof ClawGatewayConsentError ||
              error instanceof ClawSkillConsentError ||
              (error instanceof ClawGatewayPlanError &&
                (error.code === "claw_not_found" ||
                  error.code === "claw_update_source_mismatch")) ||
              (error instanceof ClawHubSourceError &&
                error.code === "clawhub_risk_acknowledgement_required")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      const message =
        error instanceof ClawGatewayAuthorityError ||
        error instanceof ClawGatewayPlanChangedError ||
        error instanceof ClawGatewayConsentError ||
        error instanceof ClawSkillConsentError ||
        error instanceof ClawGatewayPlanError ||
        error instanceof ClawHubSourceError
          ? error.message
          : "Claw update is unavailable. Review Claws status before retrying.";
      respond(false, undefined, errorShape(code, message));
    }
  },
  "claws.remove.plan": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateClawsRemovePlanParams, "claws.remove.plan", respond)) {
      return;
    }
    try {
      respond(
        true,
        await planClawRemoveForGateway({
          agentId: params.agentId,
          config: context.getRuntimeConfig(),
          monitorGateway: createServingClawMonitorCleanupGateway(context),
        }),
      );
    } catch (error) {
      respondPlanError(error, respond);
    }
  },
  "claws.remove.apply": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    if (!assertValidParams(params, validateClawsRemoveApplyParams, "claws.remove.apply", respond)) {
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
        throw new ClawGatewayAuthorityError("Claw removal authority is no longer active.");
      }
    };
    try {
      assertCurrent();
      const result = await applyClawRemoveForGateway({
        agentId: params.agentId,
        planIntegrity: params.planIntegrity,
        getRuntimeConfig: () => context.getRuntimeConfig(),
        monitorGateway: createServingClawMonitorCleanupGateway(context, assertCurrent),
        createApplyCallbacks: (assertApplyCurrent, reviewedPackageActions) => ({
          monitorGateway: createServingClawMonitorCleanupGateway(context, assertApplyCurrent),
          packageGateway: createServingClawPackageRemovalGateway(
            context,
            assertApplyCurrent,
            reviewedPackageActions,
            signal,
          ),
          cronGateway: {
            get: async (schedulerJobId) => {
              assertApplyCurrent();
              const job = await context.cron.readJob(schedulerJobId);
              assertApplyCurrent();
              return job;
            },
            remove: async (schedulerJobId, options) => {
              assertApplyCurrent();
              return await context.cron.remove(schedulerJobId, {
                commitGuard: () => {
                  assertApplyCurrent();
                  options?.commitGuard?.();
                },
              });
            },
          },
        }),
        assertCurrent,
        ...(signal ? { signal } : {}),
      });
      respond(true, result);
    } catch (error) {
      log.error("claws.remove.apply was refused before the removal command started.");
      const code =
        error instanceof ClawGatewayAuthorityError
          ? ErrorCodes.FORBIDDEN
          : error instanceof ClawGatewayPlanChangedError ||
              (error instanceof ClawGatewayPlanError && error.code === "claw_not_found")
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
      const message =
        error instanceof ClawGatewayAuthorityError ||
        error instanceof ClawGatewayPlanChangedError ||
        error instanceof ClawGatewayPlanError
          ? error.message
          : "Claw removal is unavailable. Review Claws status before retrying.";
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
