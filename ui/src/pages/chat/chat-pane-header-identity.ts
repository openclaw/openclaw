import type { GatewaySessionRow } from "../../api/types.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badge-presentation.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";

export function resolveChatPaneWorkspace(params: {
  session: GatewaySessionRow | undefined;
  agentWorkspace: string | undefined;
  methodAdvertised: boolean;
  hasAdminAccess: boolean;
  worktreePaths: ReadonlyMap<string, { path?: string | null }>;
  branches: ReadonlyMap<string, { value?: string | null }>;
}) {
  const { session, agentWorkspace, worktreePaths, branches } = params;
  const worktree = session?.worktree;
  const workspace = resolveSessionWorkspace({
    session,
    agentWorkspace: worktree ? undefined : agentWorkspace,
    worktreePath: worktree ? worktreePaths.get(worktree.id)?.path : undefined,
  });
  // Managed worktrees use their recorded branch. Cached HEAD belongs to a local
  // checkout root and cannot describe a session that is running remotely.
  const remote =
    Boolean(session?.execNode) || isCloudWorkerPlacementState(session?.placement?.state);
  const branch =
    session?.repository?.branch ||
    worktree?.branch ||
    (remote || !workspace.root ? null : branches.get(workspace.root)?.value) ||
    null;
  const defaultWorkspace =
    !remote &&
    !worktree &&
    !session?.repository &&
    !session?.repositoryWorkspaceId &&
    !session?.deviceFolder &&
    workspace.root === agentWorkspace?.trim();
  return {
    ...workspace,
    label: defaultWorkspace ? null : workspace.label,
    branch,
    canReveal: Boolean(
      workspace.root && params.methodAdvertised && params.hasAdminAccess && !remote,
    ),
  };
}

export function resolveChatPaneParentSession(
  session: GatewaySessionRow | undefined,
  sessions: readonly GatewaySessionRow[],
) {
  const parentKey = resolveUiSessionNavigationParentKey(session);
  if (!parentKey || (session && areUiSessionKeysEquivalent(parentKey, session.key))) {
    return null;
  }
  const parent = sessions.find((row) => areUiSessionKeysEquivalent(row.key, parentKey));
  return parent ? { key: parent.key, title: resolveSessionDisplayName(parent.key, parent) } : null;
}
