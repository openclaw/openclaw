// Builds the config-commit transform for a consented Claw add: merges the new agent into the
// roster, or replaces a matching legacy-resume entry, refusing an agent-id or workspace collision.
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { ClawAddMutationError } from "./add-errors.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import { exactExistingAgentIsAuthorized } from "./agent-adoption-apply.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

/** The committed config transform for `applyClawAddPlan`; throws `ClawAddMutationError` on a
 * post-plan collision so the caller's commit retry loop reports the conflict as a plan failure. */
export function commitClawAddAgentConfig(params: {
  config: OpenClawConfig;
  plan: ClawAddPlan;
  workspace: string;
  resumePlan?: ClawAddPlan;
  resumeRecord?: PersistedClawInstall;
  agentAdoption?: boolean;
  durableConfigCommitted: boolean;
}): OpenClawConfig {
  const { config, plan, workspace } = params;
  const existingAgents = listAgentEntries(config);
  const agentsToPreserve: AgentConfig[] =
    existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
  const configWithPreservedAgents: OpenClawConfig = {
    ...config,
    agents: {
      ...config.agents,
      entries: Object.fromEntries(agentsToPreserve.map(({ id, ...entry }) => [id, entry])),
    },
  };
  if (
    findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
      .length > 0
  ) {
    throw new ClawAddMutationError(
      params.agentAdoption ? "agent_workspace_conflict" : "workspace_collision",
      params.agentAdoption
        ? "Workspace " + JSON.stringify(workspace) + " is assigned to another agent."
        : "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
    );
  }
  const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
  const existingAgent = agentsToPreserve.find(
    (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
  );
  if (existingAgent) {
    if (
      sameCommittedAgent(existingAgent, plan) &&
      exactExistingAgentIsAuthorized({
        adoption: params.agentAdoption ?? false,
        durableConfigCommitted: params.durableConfigCommitted,
      })
    ) {
      return config;
    }
    const nextConfig = replaceLegacyCommittedAgent({
      config: configWithPreservedAgents,
      agents: agentsToPreserve,
      normalizedAgentId,
      plan,
      resumePlan: params.resumePlan,
      resumeRecord: params.resumeRecord,
      matchesPlan: sameCommittedAgent,
    });
    if (nextConfig) {
      return nextConfig;
    }
    throw new ClawAddMutationError(
      params.agentAdoption ? "agent_config_conflict" : "agent_id_collision",
      params.agentAdoption
        ? `Agent ${JSON.stringify(plan.agent.finalId)} changed after adoption planning.`
        : "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
    );
  }
  if (params.agentAdoption) {
    throw new ClawAddMutationError(
      "agent_config_conflict",
      `Agent ${JSON.stringify(plan.agent.finalId)} disappeared after adoption planning.`,
    );
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      entries: Object.fromEntries(
        [...agentsToPreserve, plan.agent.config].map(({ id, ...entry }) => [id, entry]),
      ),
    },
  };
}
