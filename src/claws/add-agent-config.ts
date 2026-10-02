import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { ClawAddMutationError } from "./add-mutation-error.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function addClawAgentToConfig(
  config: OpenClawConfig,
  plan: ClawAddPlan,
  workspace: string,
  resumePlan: ClawAddPlan | undefined,
  resumeRecord: PersistedClawInstall | undefined,
): OpenClawConfig {
  const existingAgents = listAgentEntries(config);
  const agentsToPreserve: AgentConfig[] =
    existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
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
    const nextConfig = replaceLegacyCommittedAgent({
      config: configWithPreservedAgents,
      agents: agentsToPreserve,
      normalizedAgentId,
      plan,
      resumePlan,
      resumeRecord,
      matchesPlan: sameCommittedAgent,
    });
    if (nextConfig) {
      return nextConfig;
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
  const nextConfig: OpenClawConfig = {
    ...config,
    agents: {
      ...config.agents,
      entries: toAgentEntriesRecord([...agentsToPreserve, plan.agent.config]),
    },
  };
  return nextConfig;
}
