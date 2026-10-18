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
    load: (scope) => {
      // Review and Environment ask the same owner; join only identical in-flight scopes.
      if (scope.scope === "uncommitted" && uncommittedLoad) {
        return uncommittedLoad;
      }
      const request = client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
      });
      if (scope.scope !== "uncommitted") {
        return request;
      }
      uncommittedLoad = request
        .then((result) => {
          content.onResult?.({ owner: workspace, scope, result });
          return result;
        })
        .finally(() => {
          uncommittedLoad = undefined;
        });
      return uncommittedLoad;
    },
    requestUncommitted: () => {
      const current = workspace.diffContent;
      if (
        !state.connected ||
        !isCurrentSessionWorkspace(state, workspace) ||
        current?.kind !== "session-diff" ||
        current.load !== content.load
      ) {
        return;
      }
      // Renewed visible demand revalidates even clean/unavailable results: external
      // edits need not emit a session event. Ordinary renders keep this callback stable.
      void content.load({ scope: "uncommitted" }).catch(() => {});
    },
    onResult: ({ owner, scope, result }) => {
      const current = workspace.diffContent;
      if (
        owner !== workspace ||
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
