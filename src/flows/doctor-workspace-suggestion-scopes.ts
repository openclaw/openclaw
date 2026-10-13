import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type DoctorWorkspaceSuggestionScope = {
  agentId: string;
  workspaceDir: string;
  labelAgent: boolean;
};

/** Resolves every configured agent workspace; an explicitly empty roster owns none. */
export function resolveDoctorWorkspaceSuggestionScopes(
  cfg: OpenClawConfig,
): DoctorWorkspaceSuggestionScope[] {
  const agentIds = listAgentIds(cfg);
  const labelAgent = agentIds.length > 1;
  return agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    labelAgent,
  }));
}
