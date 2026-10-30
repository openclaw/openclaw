import path from "node:path";

export type ExecutionSkillWorkspace = {
  executionWorkspaceDir?: string;
  /** Managed canonical sources belong to Gateway, not the agent workspace host. */
  executionWorkspaceFileHost?: "gateway";
};

type WorkspaceSkillRoots = ExecutionSkillWorkspace & { agentWorkspaceDir: string };

export function resolveSessionSkillExecutionWorkspace(
  canonicalWorkspaceDir: string | undefined,
  executionWorkspaceDir: string | undefined,
): ExecutionSkillWorkspace {
  return canonicalWorkspaceDir
    ? { executionWorkspaceDir: canonicalWorkspaceDir, executionWorkspaceFileHost: "gateway" }
    : { executionWorkspaceDir };
}

export function normalizeWorkspaceSkillRoots(roots: WorkspaceSkillRoots): WorkspaceSkillRoots {
  const agentWorkspaceDir = path.resolve(roots.agentWorkspaceDir);
  const executionWorkspaceDir = roots.executionWorkspaceDir
    ? path.resolve(roots.executionWorkspaceDir)
    : undefined;
  return executionWorkspaceDir &&
    (executionWorkspaceDir !== agentWorkspaceDir || roots.executionWorkspaceFileHost)
    ? {
        agentWorkspaceDir,
        executionWorkspaceDir,
        ...(roots.executionWorkspaceFileHost
          ? { executionWorkspaceFileHost: roots.executionWorkspaceFileHost }
          : {}),
      }
    : { agentWorkspaceDir };
}

// Discovery and watching share the same low-to-high local precedence. Callers
// supply the admitted workspace: never walk ancestors into another repository.
export function resolveWorkspaceSkillDirectories(workspaceDir: string, workspaceOnly = false) {
  const workspace = {
    dir: path.resolve(workspaceDir, "skills"),
    source: "openclaw-workspace",
  };
  return workspaceOnly
    ? [workspace]
    : [
        { dir: path.resolve(workspaceDir, ".agents", "skills"), source: "agents-skills-project" },
        workspace,
      ];
}
