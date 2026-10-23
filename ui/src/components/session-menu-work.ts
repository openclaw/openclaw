import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isNativeLocalGateway } from "../app/native-editor-locality.runtime.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { primarySessionPullRequest } from "../lib/session-pull-request-presentation.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SessionMenuWork } from "./session-menu-solid.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same worktree-session extras (PR link, checkout path) when opening the
// session context menu, after the menu is already visible.
type SessionMenuWorkParams = {
  client: Pick<GatewayBrowserClient, "request">;
  /** Omitted when the Gateway does not advertise pushed PR snapshots. */
  loadPullRequests?: () => Promise<ControlUiSessionPullRequestSnapshot | undefined>;
  worktreeId?: string;
  execNode?: string;
};

type SessionMenuWorkResult = {
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

async function loadPullRequestUrl(params: SessionMenuWorkParams): Promise<string | null> {
  try {
    const snapshot = await params.loadPullRequests?.();
    return primarySessionPullRequest(snapshot?.pullRequests ?? [])?.url ?? null;
  } catch {
    // Optional affordance: a GitHub or gateway hiccup just leaves Open PR disabled.
    return null;
  }
}

async function loadWorktreePath(params: SessionMenuWorkParams): Promise<string | null> {
  const worktreeId = params.worktreeId;
  if (!worktreeId || params.execNode) {
    return null;
  }
  if (!isNativeLocalGateway()) {
    return null;
  }
  try {
    const result = await params.client.request<{ worktrees: WorktreeRecord[] }>(
      "worktrees.list",
      {},
    );
    const record = result.worktrees.find(
      (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
    );
    return record?.path ?? null;
  } catch {
    return null;
  }
}

export async function fetchSessionMenuWork(
  params: SessionMenuWorkParams,
): Promise<SessionMenuWorkResult> {
  const [pullRequestUrl, worktreePath] = await Promise.all([
    loadPullRequestUrl(params),
    loadWorktreePath(params),
  ]);
  return { pullRequestUrl, worktreePath };
}

export function createSessionMenuWork(
  host: SidebarMenusOwner,
  setWork: (work: SessionMenuWork | null) => void,
) {
  const sessionMenuWorkOwner = {};
  let sessionMenuWorkStore: ReturnType<typeof sessionPullRequestsForGateway> | null = null;
  let stopSessionMenuGateway: (() => void) | undefined;
  let sessionMenuWorkVersion = 0;

  function releaseSessionMenuWork() {
    sessionMenuWorkVersion += 1;
    stopSessionMenuGateway?.();
    stopSessionMenuGateway = undefined;
    sessionMenuWorkStore?.unwatch(sessionMenuWorkOwner);
    sessionMenuWorkStore = null;
  }

  function loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++sessionMenuWorkVersion;
    const context = host.sessionDataContext;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    setWork(
      session.worktreeId
        ? {
            pullRequestUrl: null,
            worktreePath: null,
          }
        : null,
    );
    if (!session.worktreeId || !context) {
      return;
    }
    // A replacement connection retires pending menu work before starting its successor.
    stopSessionMenuGateway = context.gateway.subscribe((next) => {
      if (next.phase === "connected" && next.client !== client) {
        releaseSessionMenuWork();
        loadSessionMenuWork(session);
      }
    });
    if (!client) {
      return;
    }
    const { selectedAgentId } = host.getSessionNavigationState();
    const store = (sessionMenuWorkStore = sessionPullRequestsForGateway(context.gateway));
    const pullRequestKey = scopedSessionArtifactKey(
      session.key,
      parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
    );
    void fetchSessionMenuWork({
      client,
      loadPullRequests: canCallGatewayMethod(
        context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(sessionMenuWorkOwner, pullRequestKey)
        : undefined,
      worktreeId: session.worktreeId,
      execNode: session.execNode,
    }).then((work) => {
      if (
        version === sessionMenuWorkVersion &&
        // A replacement provider wrapper may retain the same Gateway and client.
        host.sessionDataContext?.gateway === context.gateway &&
        context.gateway.snapshot.client === client
      ) {
        setWork(work);
      }
    });
  }

  return { load: loadSessionMenuWork, release: releaseSessionMenuWork };
}
