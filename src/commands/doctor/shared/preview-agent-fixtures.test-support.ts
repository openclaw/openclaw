import type { OpenClawConfig } from "../../../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { AgentToolsConfig } from "../../../config/types.tools.js";

export const agentRosterCases = [
  {
    name: "list",
    path: "agents.list[0]",
    otherPath: "agents.entries",
    agents: (tools: AgentToolsConfig): OpenClawConfigWithLegacyRoster["agents"] => ({
      list: [{ id: "sage", tools }],
    }),
  },
  {
    name: "keyed",
    path: "agents.entries.sage",
    otherPath: "agents.list",
    agents: (tools: AgentToolsConfig): OpenClawConfig["agents"] => ({
      entries: { main: {}, sage: { tools } },
    }),
  },
];

export function createMessagePolicyAgents(
  routedAgentId: string,
): NonNullable<OpenClawConfigWithLegacyRoster["agents"]> {
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
