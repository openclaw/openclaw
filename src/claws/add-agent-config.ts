import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { ClawAddMutationError } from "./add-mutation-error.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import type { ClawAddPlan } from "./types.js";

export function addClawAgentToConfig(
  config: OpenClawConfig,
  plan: ClawAddPlan,
  workspace: string,
): OpenClawConfig {
  const existingAgents = listAgentEntries(config);
  const agentsToPreserve: AgentConfig[] =
    existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID }];
  const configWithPreservedAgents: OpenClawConfig = {
    ...config,
    agents: {
      ...config.agents,
      entries: toAgentEntriesRecord(agentsToPreserve),
    },
  };
  const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
  const existingAgent = agentsToPreserve.find(
    (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
  );
  if (existingAgent) {
    if (sameCommittedAgent(existingAgent, plan)) {
      return config;
    }
    throw new ClawAddMutationError(
      "agent_id_collision",
      "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
    );
  }
  if (
    findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
      .length > 0
  ) {
    throw new ClawAddMutationError(
      "workspace_collision",
      "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
    );
  }
  const nextConfig = applyAgentConfig(configWithPreservedAgents, {
    agentId: normalizedAgentId,
  });
  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      entries: {
        ...nextConfig.agents?.entries,
        ...toAgentEntriesRecord([plan.agent.config]),
      },
    },
  };
}
