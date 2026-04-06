import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsStartToolSchema = Type.Object({
  agentId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: "The agent ID to start a session for.",
  }),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force a new session even if one already exists. Dangerous: the existing session is discarded.",
    }),
  ),
});

type GatewayCaller = typeof callGateway;

export function createSessionsStartTool(opts?: { callGateway?: GatewayCaller }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_start",
    description:
      "Start (or verify) a session for a given agent. Returns the session key and whether a new session was created. Use before sessions_send when you need to guarantee a session is ready.",
    parameters: SessionsStartToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const agentId = readStringParam(params, "agentId", { required: true });
      const force = params.force === true ? true : undefined;

      try {
        const response = await gatewayCall<{
          ok: boolean;
          key: string;
          wasCreated: boolean;
          contextOverflowed: boolean;
          sessionId: string;
        }>({
          method: "sessions.start",
          params: {
            agentId,
            ...(force !== undefined ? { force } : {}),
          },
          timeoutMs: 10_000,
        });

        return jsonResult({
          status: response?.wasCreated ? "created" : "exists",
          sessionKey: response?.key,
          sessionId: response?.sessionId,
          contextOverflowed: response?.contextOverflowed ?? false,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        // Map gateway error codes to meaningful statuses
        if (messageText.includes("AGENT_NOT_FOUND") || messageText.includes("agent not found")) {
          return jsonResult({
            status: "agent_not_found",
            error: messageText,
          });
        }
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
