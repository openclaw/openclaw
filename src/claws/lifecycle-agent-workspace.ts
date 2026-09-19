import { workspacePathsOverlap } from "../agents/agent-delete-safety.js";
import type { ExistingClawAgent } from "./lifecycle-agent-plan.js";

export function inspectAgentWorkspaceOwnership(params: {
  existingAgents?: Iterable<ExistingClawAgent>;
  existingWorkspacePaths?: Iterable<string>;
  finalId: string;
  workspace: string;
  adopting: boolean;
  canonicalize: (path: string) => string;
}) {
  const existingAgents = [...(params.existingAgents ?? [])];
  const adoptedAgent = existingAgents.find((agent) => agent.id === params.finalId);
  const workspaceOf = (agent: ExistingClawAgent) => {
    const workspace = agent.resolvedWorkspace ?? agent.workspace;
    return workspace ? params.canonicalize(workspace) : undefined;
  };
  const agentCandidates = existingAgents.flatMap((agent) => {
    const path = workspaceOf(agent);
    return path ? [{ agentId: agent.id, path }] : [];
  });
  const identifiedPaths = new Set(agentCandidates.map((candidate) => candidate.path));
  // Some callers have agent identity for only part of the roster. Keep supplemental path-only
  // ownership while letting the identified candidate represent duplicate paths.
  const pathCandidates = [...(params.existingWorkspacePaths ?? [])]
    .map((path) => params.canonicalize(path))
    .filter((path) => !identifiedPaths.has(path))
    .map((path) => ({ agentId: undefined, path }));
  const candidates = [...agentCandidates, ...pathCandidates];
  // Ancestor/descendant overlap with any other agent's workspace is the same collision the
  // config commit rejects via findOverlappingWorkspaceAgentIds; an adopted agent must sit at
  // exactly this workspace, so its own entry conflicts only when the paths differ.
  const configuredWorkspaceConflict = candidates.some((candidate) =>
    params.adopting && candidate.agentId === params.finalId
      ? candidate.path !== params.workspace
      : workspacePathsOverlap(params.workspace, candidate.path),
  );
  return {
    configuredWorkspaceConflict,
    adoptedAgentWorkspace: adoptedAgent ? workspaceOf(adoptedAgent) : undefined,
  };
}
