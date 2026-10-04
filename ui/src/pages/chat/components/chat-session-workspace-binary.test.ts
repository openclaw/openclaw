// Binary workspace files open as attachments served by the access-checked media route.
import { describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  createSidebarContentRecorder,
  loadedSidebarContent,
} from "./chat-session-workspace.test-support.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";

describe("openSessionWorkspaceFile binary files", () => {
  it("opens binary workspace files as attachments served through assistant media", async () => {
    const handleOpenSidebar = createSidebarContentRecorder();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/work",
      file: {
        path: "docs/report.pdf",
        workspacePath: "docs/report.pdf",
        name: "report.pdf",
        kind: "read",
        missing: false,
        mimeType: "application/pdf",
        previewKind: "unsupported",
        size: 161_077,
      },
    });
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "docs/report.pdf" });

    const sidebarContent = await loadedSidebarContent(state);
    expect(sidebarContent).toMatchObject({
      kind: "attachment",
      attachmentKind: "document",
      title: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 161_077,
      sourceIdentity: "/work/docs/report.pdf",
    });
  });

  it("serves binary files outside the workspace root from their absolute path", async () => {
    const handleOpenSidebar = createSidebarContentRecorder();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/work",
      file: {
        path: "/srv/shared/report.pdf",
        workspacePath: "/srv/shared/report.pdf",
        name: "report.pdf",
        kind: "read",
        missing: false,
        mimeType: "application/pdf",
        previewKind: "unsupported",
        size: 2048,
      },
    });
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "/srv/shared/report.pdf" });

    expect(await loadedSidebarContent(state)).toMatchObject({
      kind: "attachment",
      sourceIdentity: "/srv/shared/report.pdf",
    });
  });

  it("resolves relayed file links in the sending session's workspace", async () => {
    const handleOpenSidebar = createSidebarContentRecorder();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:content:main",
      root: "/agents/content",
      file: {
        path: "tmp/amendment.pdf",
        workspacePath: "tmp/amendment.pdf",
        name: "amendment.pdf",
        kind: "read",
        missing: false,
        mimeType: "application/pdf",
        previewKind: "unsupported",
        size: 2048,
      },
    });
    const fetchMock = vi.fn((_input: string) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:main",
      sidebarContent: null,
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    try {
      openSessionWorkspaceFile(state, {
        path: "tmp/amendment.pdf",
        sessionKey: "agent:content:main",
      });

      const sidebarContent = await loadedSidebarContent(state);
      expect(getFile).toHaveBeenCalledWith("agent:content:main", "tmp/amendment.pdf", {
        agentId: "content",
      });
      expect(sidebarContent).toMatchObject({
        kind: "attachment",
        sourceIdentity: "/agents/content/tmp/amendment.pdf",
      });
      const resolution =
        sidebarContent.kind === "attachment"
          ? sidebarContent.resolveSource?.(() => {}, {
              sessionKey: "agent:main:main",
              agentId: "main",
            })
          : undefined;
      expect(resolution).toEqual({ status: "pending" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const metaUrl = new URL(fetchMock.mock.calls[0]?.[0] ?? "", "http://localhost");
      expect(metaUrl.pathname).toBe("/__openclaw__/assistant-media");
      expect(metaUrl.searchParams.get("source")).toBe("/agents/content/tmp/amendment.pdf");
      expect(metaUrl.searchParams.get("sessionKey")).toBe("agent:content:main");
      expect(metaUrl.searchParams.get("agentId")).toBe("content");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
