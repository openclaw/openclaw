import {
  ErrorCodes,
  errorShape,
  validateSessionsCleanupParams,
  validateSessionsStorageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runSessionsCleanup, serializeSessionCleanupResult } from "../../config/sessions.js";
import { getSessionColdStorageStatus } from "../../config/sessions/session-cold-storage-status.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getSessionColdStorageMaintenanceStatus,
  requestGatewaySessionColdStorageMaintenance,
} from "../session-cold-storage-maintenance.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const maintenanceError = (error: unknown) =>
  errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error));

function createSessionStorageHandler(
  method: "sessions.storage.status" | "sessions.storage.run",
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(
    method,
    validateSessionsStorageParams,
    async ({
      respond,
      context,
      sessionMutationAuthorization,
      sessionMutationCommitGuard,
      signal,
      hasCurrentClientAuthority,
    }) => {
      const agents = await getSessionColdStorageStatus(context.getRuntimeConfig());
      signal?.throwIfAborted();
      sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      if (hasCurrentClientAuthority?.() === false) {
        throw new Error("Transcript maintenance requester is no longer authorized");
      }
      if (method === "sessions.storage.run") {
        requestGatewaySessionColdStorageMaintenance(context.getRuntimeConfig);
      }
      respond(
        true,
        {
          agents,
          maintenance: getSessionColdStorageMaintenanceStatus(context.getRuntimeConfig),
        },
        undefined,
      );
    },
    maintenanceError,
  );
}

export const sessionMaintenanceHandlers: GatewayRequestHandlers = {
  "sessions.storage.status": createSessionStorageHandler("sessions.storage.status"),
  "sessions.storage.run": createSessionStorageHandler("sessions.storage.run"),
  "sessions.cleanup": defineValidatedGatewayHandler(
    "sessions.cleanup",
    validateSessionsCleanupParams,
    async ({ params, respond, context }) => {
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
    },
    maintenanceError,
  ),
};
