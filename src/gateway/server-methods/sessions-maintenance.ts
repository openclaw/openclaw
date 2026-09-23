import {
  ErrorCodes,
  errorShape,
  validateSessionsCleanupParams,
  validateSessionsStorageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runSessionsCleanup, serializeSessionCleanupResult } from "../../config/sessions.js";
import { getSessionColdStorageStatus } from "../../config/sessions/session-cold-storage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getSessionColdStorageMaintenanceStatus,
  requestGatewaySessionColdStorageMaintenance,
} from "../session-cold-storage-maintenance.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionMaintenanceHandlers: GatewayRequestHandlers = {
  "sessions.storage.status": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsStorageParams, "sessions.storage.status", respond)
    ) {
      return;
    }
    try {
      const agents = await getSessionColdStorageStatus(context.getRuntimeConfig());
      respond(
        true,
        {
          agents,
          maintenance: getSessionColdStorageMaintenanceStatus(context.getRuntimeConfig),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.storage.run": async ({
    params,
    respond,
    context,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
    signal,
    hasCurrentClientAuthority,
  }) => {
    if (
      !assertValidParams(params, validateSessionsStorageParams, "sessions.storage.run", respond)
    ) {
      return;
    }
    try {
      const agents = await getSessionColdStorageStatus(context.getRuntimeConfig());
      signal?.throwIfAborted();
      sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      if (hasCurrentClientAuthority?.() === false) {
        throw new Error("Transcript maintenance requester is no longer authorized");
      }
      requestGatewaySessionColdStorageMaintenance(context.getRuntimeConfig);
      respond(
        true,
        {
          agents,
          maintenance: getSessionColdStorageMaintenanceStatus(context.getRuntimeConfig),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.cleanup": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) {
      return;
    }
    try {
      const { mode, appliedSummaries, failure } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: params.agent,
          allAgents: params.allAgents,
          enforce: params.enforce,
          activeKey: params.activeKey,
          fixMissing: params.fixMissing,
          fixDmScope: params.fixDmScope,
        },
      });
      const result = serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
        failure,
      });
      if (failure) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, failure.message, { details: result }),
        );
      } else {
        respond(true, result, undefined);
      }
      for (const summary of appliedSummaries) {
        emitSessionsChanged(context, { reason: "cleanup", sessionKey: undefined });
        if (summary.wouldMutate) {
          context.logGateway.debug(
            `sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`,
          );
        }
      }
      if (failure?.lifecycleCommitted) {
        emitSessionsChanged(context, { reason: "cleanup", sessionKey: undefined });
      }
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
};
