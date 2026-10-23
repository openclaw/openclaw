import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { readWorkspaceFileText } from "./chat-session-workspace-file-content.ts";
import {
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  sessionWorkspaceForHost,
  trackSessionCheckoutSidebar,
} from "./chat-session-workspace-state.ts";
import type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";
import type { SessionWorkspacePreview, SidebarContent } from "./chat-sidebar-content-types.ts";

export function resolveSessionWorkspaceDiff(
  state: SessionWorkspaceHost,
  openFile: (path: string) => Promise<SessionWorkspacePreview | undefined> | undefined,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  const client = state.client;
  if (isGatewayMethodAdvertised(state, "sessions.diff") !== true || !client) {
    return null;
  }
  if (workspace.diffContent) {
    return workspace.diffContent;
  }
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  const canLoadFileText =
    isGatewayMethodAdvertised(state, "sessions.files.get") === true && Boolean(state.client);
  let uncommittedLoad: Promise<SessionsDiffResult> | undefined;
  const content: Extract<SidebarContent, { kind: "session-diff" }> = {
    kind: "session-diff",
    // Checkout retirement replaces this identity; ordinary refreshes retain it.
    owner: workspace,
    load: (scope, options) => {
      // Background readers share a request; explicit refresh revalidates native state.
      if (scope.scope === "uncommitted" && uncommittedLoad && !options?.refresh) {
        return uncommittedLoad;
      }
      const request = client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
        poll: !options?.refresh,
      });
      if (scope.scope !== "uncommitted") {
        return request;
      }
      const load: Promise<SessionsDiffResult> = request
        .then((result) => {
          if (uncommittedLoad === load) {
            content.onResult?.({ owner: workspace, scope, result });
          }
          return result;
        })
        .finally(() => {
          if (uncommittedLoad === load) {
            uncommittedLoad = undefined;
          }
        });
      uncommittedLoad = load;
      return load;
    },
    requestUncommitted: () => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = async () => {
        const current = workspace.diffContent;
        if (
          !active ||
          !state.connected ||
          !isCurrentSessionWorkspace(state, workspace) ||
          current?.kind !== "session-diff" ||
          current.load !== content.load
        ) {
          return;
        }
        try {
          const result = await content.load({ scope: "uncommitted" });
          if (active && result.computing) {
            timer = setTimeout(() => void refresh(), 500);
          }
        } catch {
          // A later visible demand retries errors; only computing responses poll.
        }
      };
      void refresh();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    },
    onResult: ({ owner, scope, result }) => {
      const current = workspace.diffContent;
      if (
        owner !== workspace ||
        result.computing ||
        scope.scope !== "uncommitted" ||
        !isCurrentSessionWorkspace(state, workspace) ||
        current?.kind !== "session-diff" ||
        current.load !== content.load ||
        current.uncommitted === result
      ) {
        return;
      }
      current.uncommitted = result;
      sessionWorkspaceForHost(state).publish();
    },
    loadFileText: canLoadFileText
      ? async (path) => {
          try {
            const result = await state.sessions.getFile(sessionKey, path, {
              agentId,
            });
            return readWorkspaceFileText(result?.file);
          } catch {
            return null;
          }
        }
      : undefined,
    openFile,
  };
  trackSessionCheckoutSidebar(content);
  workspace.diffContent = content;
  return content;
}
