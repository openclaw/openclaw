// Gateway RPC handlers for safe gateway restart requests and preflight state.
<<<<<<< HEAD
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import type { GatewayRequestHandlers } from "./types.js";

<<<<<<< HEAD
function isRestartRequestParams(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function normalizeReason(value: unknown): string | undefined {
  // Restart reasons are operator-visible log context, not payload storage.
  // Trim and cap them before passing through to the coordinator.
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function normalizeSkipDeferral(value: unknown): boolean {
  // Only an explicit boolean may bypass deferral; truthy strings from loose
  // clients must not skip the safe-restart preflight queue.
  return value === true;
}

/** Gateway request handlers for safe restart coordination. */
export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart.request": async ({ respond, params }) => {
<<<<<<< HEAD
    if (!isRestartRequestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid gateway.restart.request params"),
      );
      return;
    }
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const result = requestSafeGatewayRestart({
      reason: normalizeReason(params.reason),
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
    });
    respond(true, result);
  },
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
