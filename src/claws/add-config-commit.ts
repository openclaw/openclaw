// Builds the config-commit transform for a consented Claw add: merges the new agent into the
// roster, keeps an exactly matching adopted or resumed agent, replaces a matching legacy-resume
// entry, and refuses an agent-id, adoption, or workspace collision.
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { ClawAddMutationError } from "./add-errors.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import { exactExistingAgentIsAuthorized } from "./agent-adoption-apply.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

/** The committed config transform for `applyClawAddPlan`; throws `ClawAddMutationError` on a
 * post-plan collision so the caller's commit retry loop reports the conflict as a plan failure. */
export function commitClawAddAgentConfig(params: {
  config: OpenClawConfig;
  plan: ClawAddPlan;
  workspace: string;
  agentAdoption: boolean;
  persistedStatus: ClawInstallStatus;
  resumePlan?: ClawAddPlan;
  resumeRecord?: PersistedClawInstall;
}): OpenClawConfig {
  const { config, plan, workspace, agentAdoption } = params;
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
  const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
  const existingAgent = agentsToPreserve.find(
    (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
  );
  if (existingAgent) {
    if (
      sameCommittedAgent(existingAgent, plan) &&
      exactExistingAgentIsAuthorized({
        adoption: agentAdoption,
        resume: params.resumeRecord !== undefined,
        persistedStatus: params.persistedStatus,
      })
    ) {
      if (
        findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
          .length > 0
      ) {
        throw new ClawAddMutationError(
          "agent_workspace_conflict",
          "Workspace " + JSON.stringify(workspace) + " is assigned to another agent.",
        );
      }
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
      agentAdoption ? "agent_config_conflict" : "agent_id_collision",
      agentAdoption
        ? `Agent ${JSON.stringify(plan.agent.finalId)} changed after adoption planning.`
        : "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
    );
  }
  if (agentAdoption) {
    throw new ClawAddMutationError(
      "agent_config_conflict",
      `Agent ${JSON.stringify(plan.agent.finalId)} disappeared after adoption planning.`,
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
