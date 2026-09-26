import {
  PresenceQueryParamsSchema,
  PresenceQueryResultSchema,
  type PresenceQueryResult,
} from "../../../packages/gateway-protocol/src/schema/presence.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { bindAgentToolGatewayRequest } from "./in-process-gateway.js";
import { PRESENCE_QUERY_TIMEOUT_MS, PRESENCE_TOOL_DESCRIPTION } from "./presence-tool-contract.js";

export function createPresenceTool(): AnyAgentTool {
  return {
    name: "presence",
    label: "Presence",
    description: PRESENCE_TOOL_DESCRIPTION,
    parameters: PresenceQueryParamsSchema,
    outputSchema: PresenceQueryResultSchema,
    execute: async (_toolCallId, params, signal) => {
      const request = bindAgentToolGatewayRequest({ hostedOnly: true });
      return jsonResult(
        await request<PresenceQueryResult>({
          method: "presence.query",
          params,
          signal,
          timeoutMs: PRESENCE_QUERY_TIMEOUT_MS,
        }),
      );
    },
  };
}
