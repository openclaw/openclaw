import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
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
  return {
    ...workspace,
    branch,
    canReveal: canRevealSessionWorkspace({ ...params, workspaceRoot: workspace.root }),
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

function canRevealSessionWorkspace(params: {
  session: GatewaySessionRow | undefined;
  workspaceRoot: string | null;
  methodAdvertised: boolean;
  hasAdminAccess: boolean;
}): boolean {
  return Boolean(
    params.workspaceRoot &&
    params.methodAdvertised &&
    params.hasAdminAccess &&
    !params.session?.execNode &&
    !isCloudWorkerPlacementState(params.session?.placement?.state),
  );
}

export function resolveChatPaneWorkspaceIcon(params: {
  sessionKey: string | undefined;
  resourceBasePath: string;
  hello: GatewayHelloOk | null;
  token: string;
  password: string;
}) {
  if (!params.sessionKey) {
    return null;
  }
  const authTokens = resolveControlUiAuthCandidates({
    hello: params.hello,
    settings: { token: params.token },
    password: params.password,
  });
  return {
    routeUrl: buildControlUiResourcePath(
      "workspaceIcon",
      params.resourceBasePath,
      params.sessionKey,
    ),
    authTokens,
    authReady: Boolean(params.hello || authTokens.length),
    connectionId: params.hello?.server?.connId,
  };
}
