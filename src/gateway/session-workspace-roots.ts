import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";

type SessionWorkspaceEntry = Pick<
  InternalSessionEntry,
  | "spawnedCwd"
  | "spawnedWorkspaceDir"
  | "pendingWorktree"
  | "pendingProjectGitUrl"
  | "permissionMode"
  | "sandbox"
  | "sandboxMode"
  | "createdActor"
  | "repositoryWorkspaceId"
>;

type SessionFileReadContext = {
  sessionKey: string;
  fileToolsOnGatewayHost?: boolean;
  requireWorkspaceOnly?: boolean;
};

function resolveSessionFileReadScope(
  cfg: OpenClawConfig,
  agentId: string,
  entry: SessionWorkspaceEntry,
  context: SessionFileReadContext | undefined,
): "root" | "host" {
  if (
    !context?.fileToolsOnGatewayHost ||
    !context.sessionKey.trim() ||
    context.requireWorkspaceOnly ||
    entry.repositoryWorkspaceId ||
    entry.sandbox === "required" ||
    // Automation and internal runs can carry an unrecorded required execution root.
    isCronSessionKey(context.sessionKey) ||
    isInternalSessionEffectsKey(context.sessionKey)
  ) {
    return "root";
  }
  const sandbox = resolveSandboxRuntimeStatus({
    cfg,
    agentId,
    sessionKey: context.sessionKey,
    preparedSessionEntry: entry,
  });
  if (sandbox.sandboxed) {
    return "root";
  }
  const workspaceOnly = entry.permissionMode
    ? resolveSessionPermissionCoreToolPolicy({ mode: entry.permissionMode }).workspaceOnly
    : resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId });
  return workspaceOnly ? "root" : "host";
}

/** One persisted workspace owner for file browsing, diff state, and media containment. */
export function resolveSessionWorkspaceRoots(
  cfg: OpenClawConfig,
  agentId: string,
  entry: SessionWorkspaceEntry,
  readContext?: SessionFileReadContext,
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
    readScope: checkoutPending
      ? "root"
      : resolveSessionFileReadScope(cfg, agentId, entry, readContext),
    spawnedCwd,
    root: spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir,
    // The diff operates in the selected cwd while browsing contains the entire workspace.
    diffCwd: spawnedCwd ?? spawnedWorkspaceDir ?? configuredWorkspaceDir,
  };
}
