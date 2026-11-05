import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { TemplateAddMutationError } from "./add-mutation-error.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import type { TemplateAddPlan } from "./types.js";

export function addTemplateAgentToConfig(
  config: OpenClawConfig,
  plan: TemplateAddPlan,
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
    throw new TemplateAddMutationError(
      "agent_id_collision",
      "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
    );
  }
  if (
    findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
      .length > 0
  ) {
    throw new TemplateAddMutationError(
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
