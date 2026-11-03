import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isNativeLocalGateway } from "../app/native-editor-locality.runtime.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SessionMenuWork } from "./session-menu-solid.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same worktree checkout path when opening the
// session context menu, after the menu is already visible.
type SessionMenuWorkParams = {
  client: Pick<GatewayBrowserClient, "request">;
  worktreeId?: string;
  execNode?: string;
};

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
): Promise<{ worktreePath: string | null }> {
  return { worktreePath: await loadWorktreePath(params) };
}

export function createSessionMenuWork(
  host: SidebarMenusOwner,
  setWork: (work: SessionMenuWork | null) => void,
) {
  let stopSessionMenuGateway: (() => void) | undefined;
  let sessionMenuWorkVersion = 0;

  function releaseSessionMenuWork() {
    sessionMenuWorkVersion += 1;
    stopSessionMenuGateway?.();
    stopSessionMenuGateway = undefined;
  }

  function loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++sessionMenuWorkVersion;
    const context = host.sessionDataContext;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    setWork(
      session.worktreeId
        ? {
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
    void fetchSessionMenuWork({
      client,
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
