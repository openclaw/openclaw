import { agentRunHandler } from "./agent-run-handler.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
};
