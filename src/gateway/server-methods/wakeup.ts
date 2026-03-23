/**
 * Wakeup request RPC handlers.
 * Allows task assignment to enqueue async agent wakeup requests.
 */
import * as WakeupStore from "../../orchestration/wakeup-requests-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const wakeupHandlers: GatewayRequestHandlers = {
  /** Create a new pending wakeup request for an agent. */
  "wakeup.create": ({ params, respond }) => {
    const p = params;
    const agentId = asStr(p.agentId);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    try {
      const req = WakeupStore.createWakeupRequest({
        agentId,
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
        taskId: typeof p.taskId === "string" ? p.taskId : undefined,
        reason: typeof p.reason === "string" ? p.reason : undefined,
        payloadJson: typeof p.payloadJson === "string" ? p.payloadJson : undefined,
      });
      respond(true, req, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  /** List pending wakeup requests, optionally filtered by agentId. */
  "wakeup.list": ({ params, respond }) => {
    const p = params;
    const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
    try {
      const requests = WakeupStore.listPendingWakeupRequests(agentId);
      respond(true, { requests }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  /** Mark a wakeup request as processing (agent has picked it up). */
  "wakeup.process": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      WakeupStore.markWakeupProcessing(id);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  /** Mark a wakeup request as completed. */
  "wakeup.complete": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      WakeupStore.markWakeupCompleted(id);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
