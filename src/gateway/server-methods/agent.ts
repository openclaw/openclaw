import { agentRunHandler } from "./agent-run-handler.js";
import { agentWaitHandler } from "./agent-wait.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
  "agent.wait": agentWaitHandler,
};
