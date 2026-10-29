import { vi } from "vitest";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
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

export function workspaceFile(
  path: string,
  overrides: Partial<SessionWorkspaceGetResult["file"]> = {},
): SessionWorkspaceGetResult["file"] {
  return { path, name: path.split(/[\\/]/).at(-1)!, kind: "read", missing: false, ...overrides };
}

export function textFile(
  path: string,
  content: string,
  overrides: Partial<SessionWorkspaceGetResult["file"]> = {},
) {
  return workspaceFile(path, {
    previewKind: "text",
    contentEncoding: "utf8",
    content,
    ...overrides,
  });
}
