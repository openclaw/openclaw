import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { managedHandoffSentinelRequestSchema } from "../../infra/update-managed-service-handoff-sentinel-schema.js";
import { runManagedHandoffSentinelOwnerRequest } from "../../infra/update-managed-service-handoff-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";

export const updateHandoffSentinelHandlers: GatewayRequestHandlers = {
  "update.handoffSentinel": async (options) => {
    const { params, respond } = options;
    const parsed = managedHandoffSentinelRequestSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid handoff sentinel request"),
      );
      return;
    }
    try {
      const assertRequestCurrent = () => {
        options.signal?.throwIfAborted();
        options.sessionMutationAuthorization?.assertCurrent();
      };
      respond(
        true,
        await runManagedHandoffSentinelOwnerRequest(parsed.data, process.env, assertRequestCurrent),
      );
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Handoff sentinel operation failed"),
      );
    }
  },
};
