import type { AgentModelConfig } from "./types.agents-shared.js";

export type SubagentTaskRouteConfig = {
  whenTaskIncludes: string[];
  agentId?: string;
  model?: AgentModelConfig;
  thinking?: string;
};
