import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import type { GatewayRequestHandlers } from "./types.js";

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

/** Gateway RPC handlers for safe restart scheduling and preflight checks. */
export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart.request": async ({ respond, params }) => {
    // Restart requests always go through the coordinator so active work can
    // defer or coalesce the process signal consistently.
    const result = requestSafeGatewayRestart({
      reason: normalizeReason(params.reason),
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
    });
    respond(true, result);
  },
  "gateway.restart.preflight": async ({ respond }) => {
    // Preflight is read-only; clients use it to explain blockers before asking
    // for an actual restart request.
    respond(true, createSafeGatewayRestartPreflight());
  },
};
