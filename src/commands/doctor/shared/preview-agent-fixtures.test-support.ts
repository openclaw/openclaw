import type { OpenClawConfig } from "../../../config/config.js";
import type { AgentToolsConfig } from "../../../config/types.tools.js";

export const agentRosterCases = [
  {
    name: "list",
    path: "agents.list[0]",
    otherPath: "agents.entries",
    agents: (tools: AgentToolsConfig) => ({ list: [{ id: "sage", tools }] }),
  },
  {
    name: "keyed",
    path: "agents.entries.sage",
    otherPath: "agents.list",
    agents: (tools: AgentToolsConfig) => ({
      entries: { main: { default: true }, sage: { tools } },
    }),
  },
];

export function createMessagePolicyAgents(
  routedAgentId: string,
): NonNullable<OpenClawConfig["agents"]> {
  return {
    list: [
      {
        id: "main",
        default: true,
        tools: {
          allow: ["read"],
        },
      },
      {
        id: routedAgentId,
        tools: {
          profile: "messaging",
        },
      },
    ],
  };
}
