import type { AgentsListResult } from "../../api/types.ts";

export type AgentRosterEntry = {
  id: string;
  kind?: "agent" | "system";
};

/** Ordinary agent targets; system rows remain available to diagnostic surfaces. */
export function listSelectableAgents<T extends AgentRosterEntry>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.kind !== "system");
}

export function selectableAgentsList(agentsList: AgentsListResult): AgentsListResult {
  return { ...agentsList, agents: listSelectableAgents(agentsList.agents) };
}
