import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** One persisted workspace owner for file browsing, diff state, and media containment. */
export function resolveSessionWorkspaceRoots(
  cfg: OpenClawConfig,
  agentId: string,
  entry: Pick<
    InternalSessionEntry,
    "spawnedCwd" | "spawnedWorkspaceDir" | "pendingWorktree" | "pendingProjectGitUrl"
  >,
) {
  const spawnedCwd = normalizeOptionalString(entry.spawnedCwd);
  const spawnedWorkspaceDir = normalizeOptionalString(entry.spawnedWorkspaceDir);
  const checkoutPending =
    !spawnedCwd &&
    !spawnedWorkspaceDir &&
    Boolean(entry.pendingWorktree || entry.pendingProjectGitUrl);
  const configuredWorkspaceDir =
    spawnedCwd || spawnedWorkspaceDir || checkoutPending
      ? undefined
      : normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  return {
    checkoutPending,
    spawnedCwd,
    root: spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir,
    // The diff operates in the selected cwd while browsing contains the entire workspace.
    diffCwd: spawnedCwd ?? spawnedWorkspaceDir ?? configuredWorkspaceDir,
  };
}
