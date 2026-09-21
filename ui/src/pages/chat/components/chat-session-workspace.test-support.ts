import { vi } from "vitest";
import type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar-content-types.ts";

export function createSidebarContentRecorder() {
  return vi.fn(function (this: SessionWorkspaceHost, content: SidebarSelection | null) {
    if (!content?.fileTab) {
      this.sidebarContent = content;
    }
  });
}

export function loadedSidebarContent(state: SessionWorkspaceHost): Promise<SidebarContent> {
  return vi.waitFor(() => {
    const content = state.sessionWorkspaceState?.previews.find(
      (entry) => entry.id === state.sessionWorkspaceState?.activePreviewId,
    )?.content;
    if (!content || content.kind === "loading" || content.kind === "unavailable") {
      throw new Error("Sidebar content is not loaded");
    }
    return content;
  });
}

export function gatewayHello(methods: string[], scopes = ["operator.admin"]) {
  return {
    type: "hello-ok" as const,
    protocol: 3,
    auth: { role: "operator", scopes },
    features: { methods },
  };
}
