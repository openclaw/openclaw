import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import {
  getOrchestratorRequest,
  resolveOrchestratorRequest,
} from "../orchestrator-request-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const RespondOrchestratorRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  response: Type.String({ minLength: 1 }),
});

export function createRespondOrchestratorRequestTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Orchestrator",
    name: "respond_orchestrator_request",
    description: "Respond to a pending orchestrator request from a child subagent.",
    parameters: RespondOrchestratorRequestSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const requestId = readStringParam(params, "requestId", { required: true });
      const response = readStringParam(params, "response", { required: true });

      const callerSessionKey = opts?.agentSessionKey?.trim() ?? "";
      if (!callerSessionKey) {
        return jsonResult({
          status: "forbidden",
          error: "Caller session key is required to respond to orchestrator requests.",
        });
      }

      // Look up request
      const request = getOrchestratorRequest(requestId);
      if (!request) {
        return jsonResult({
          status: "not_found",
          error: `Request not found: ${requestId}`,
        });
      }

      if (request.status === "timeout") {
        return jsonResult({
          status: "expired",
          error: `Request ${requestId} has expired`,
        });
      }

      // Check if already resolved
      if (
        request.status === "resolved" ||
        request.status === "cancelled" ||
        request.status === "orphaned"
      ) {
        return jsonResult({
          status: "already_resolved",
          error: `Request ${requestId} is already ${request.status}`,
        });
      }

      // Authorize: caller must be the designated parent
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const callerInternalKey = resolveInternalSessionKey({
        key: callerSessionKey,
        alias,
        mainKey,
      });
      const parentInternalKey = resolveInternalSessionKey({
        key: request.parentSessionKey,
        alias,
        mainKey,
      });
      if (parentInternalKey !== callerInternalKey) {
        return jsonResult({
          status: "forbidden",
          error: "Only the designated parent can respond to this request.",
        });
      }

      // Resolve
      try {
        resolveOrchestratorRequest(requestId, response, callerInternalKey);
        return jsonResult({
          status: "ok",
          requestId,
          message: "Request resolved successfully.",
        });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        if (/expired/i.test(errorText)) {
          return jsonResult({
            status: "expired",
            error: errorText,
          });
        }
        return jsonResult({
          status: "error",
          error: errorText,
        });
      }
    },
  };
}
