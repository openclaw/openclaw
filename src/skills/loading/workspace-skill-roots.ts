import path from "node:path";
import type { SessionEntry } from "../../config/sessions/types.js";

/** Use the session's admitted project root, never an ancestor of its selected workspace. */
export function resolveSessionSkillWorkspaceDir(
  entry: Pick<SessionEntry, "worktree" | "spawnedCwd" | "spawnedWorkspaceDir"> | undefined,
): string | undefined {
  return entry?.worktree?.canonicalWorkspaceDir ?? entry?.spawnedCwd ?? entry?.spawnedWorkspaceDir;
}

type WorkspaceSkillRoots = {
  agentWorkspaceDir: string;
  executionWorkspaceDir?: string;
};

export function normalizeWorkspaceSkillRoots(roots: WorkspaceSkillRoots): WorkspaceSkillRoots {
  const agentWorkspaceDir = path.resolve(roots.agentWorkspaceDir);
  const executionWorkspaceDir = roots.executionWorkspaceDir
    ? path.resolve(roots.executionWorkspaceDir)
    : undefined;
  return executionWorkspaceDir && executionWorkspaceDir !== agentWorkspaceDir
    ? { agentWorkspaceDir, executionWorkspaceDir }
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
