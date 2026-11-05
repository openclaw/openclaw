import path from "node:path";
import { isWorkspaceProjectId } from "../../projects/workspace-project-id.js";

export type ExecutionSkillWorkspace = {
  executionWorkspaceDir?: string;
  /** Managed canonical sources belong to Gateway, not the agent workspace host. */
  executionWorkspaceFileHost?: "gateway";
};

type WorkspaceSkillRoots = ExecutionSkillWorkspace & { agentWorkspaceDir: string };

/** Session facts that record who admitted the session's execution root. */
export type SessionSkillRootFacts = {
  worktree?: { canonicalWorkspaceDir?: string };
  spawnedCwd?: string;
  projectId?: string;
};

export function resolveSessionSkillExecutionWorkspace(
  session: SessionSkillRootFacts | undefined,
  executionWorkspaceDir: string | undefined,
): ExecutionSkillWorkspace {
  const canonicalWorkspaceDir = session?.worktree?.canonicalWorkspaceDir;
  if (canonicalWorkspaceDir) {
    return { executionWorkspaceDir: canonicalWorkspaceDir, executionWorkspaceFileHost: "gateway" };
  }
  // A registered project's checkout was resolved and admitted on the Gateway at
  // creation, so its spawned cwd stays Gateway-owned even when a paired node serves
  // the agent workspace. Agent-workspace projects and node cwds keep their own host.
  const gatewayProjectRoot =
    session?.projectId &&
    !isWorkspaceProjectId(session.projectId) &&
    session.spawnedCwd &&
    executionWorkspaceDir === session.spawnedCwd;
  return gatewayProjectRoot
    ? { executionWorkspaceDir, executionWorkspaceFileHost: "gateway" }
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
