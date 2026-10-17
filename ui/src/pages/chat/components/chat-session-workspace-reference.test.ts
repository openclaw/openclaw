import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  createSidebarContentRecorder,
  loadedSidebarContent,
} from "./chat-session-workspace.test-support.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";

describe("session workspace file reference resolution", () => {
  it("resolves a bare filename to the nested workspace file that search finds once", async () => {
    const nestedPath = "labs/file-organizer/output/sorted-copy-001/ORGANIZATION_REPORT.md";
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey, path) => {
      if (path !== nestedPath) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session file not found",
          details: { type: "session_file_not_found" },
        });
      }
      return {
        sessionKey,
        root: "/workspace",
        file: {
          path: nestedPath,
          workspacePath: nestedPath,
          name: "ORGANIZATION_REPORT.md",
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content: "# Sorted",
          hash: "hash",
        },
      };
    });
    const listFiles = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      files: [],
      browser: {
        path: "",
        search: "ORGANIZATION_REPORT.md",
        entries: [{ path: nestedPath, name: "ORGANIZATION_REPORT.md", kind: "file" }],
      },
    });
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods(["sessions.files.list"]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: createSessionCapabilityFixture({ getFile, listFiles }),
    };

    openSessionWorkspaceFile(state, { path: "ORGANIZATION_REPORT.md" });

    const sidebarContent = await loadedSidebarContent(state);
    expect(sidebarContent.kind).toBe("file");
    expect(listFiles).toHaveBeenCalledExactlyOnceWith("agent:main:current", {
      agentId: "main",
      path: "",
      search: "ORGANIZATION_REPORT.md",
    });
    expect(getFile).toHaveBeenLastCalledWith("agent:main:current", nestedPath, {
      agentId: "main",
    });
  });

  it.each([
    {
      label: "several files share the name",
      browser: {
        path: "",
        search: "REPORT.md",
        entries: [
          { path: "a/REPORT.md", name: "REPORT.md", kind: "file" },
          { path: "b/REPORT.md", name: "REPORT.md", kind: "file" },
        ],
      },
    },
    {
      label: "the search listing was truncated",
      browser: {
        path: "",
        search: "REPORT.md",
        truncated: true,
        entries: [{ path: "a/REPORT.md", name: "REPORT.md", kind: "file" }],
      },
    },
    {
      label: "the only match escapes the workspace root",
      browser: {
        path: "",
        search: "REPORT.md",
        entries: [{ path: "../REPORT.md", name: "REPORT.md", kind: "file" }],
      },
    },
    {
      label: "the match is a directory",
      browser: {
        path: "",
        search: "REPORT.md",
        entries: [{ path: "a/REPORT.md", name: "REPORT.md", kind: "directory" }],
      },
    },
  ])("keeps the missing-file failure when $label", async ({ browser }) => {
    const missing = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "session file not found",
      details: { type: "session_file_not_found" },
    });
    const getFile = vi.fn().mockRejectedValue(missing);
    const listFiles = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      files: [],
      browser,
    });
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods(["sessions.files.list"]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: createSessionCapabilityFixture({ getFile, listFiles }),
    };

    openSessionWorkspaceFile(state, { path: "REPORT.md" });

    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews.at(-1)?.content?.kind).toBe("unavailable"),
    );
    expect(listFiles).toHaveBeenCalledOnce();
    expect(getFile).toHaveBeenCalledExactlyOnceWith("agent:main:current", "REPORT.md", {
      agentId: "main",
    });
  });

  it("never searches for a reference that already carries a path", async () => {
    const getFile = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "session file not found",
        details: { type: "session_file_not_found" },
      }),
    );
    const listFiles = vi.fn();
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods(["sessions.files.list"]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: createSessionCapabilityFixture({ getFile, listFiles }),
    };

    openSessionWorkspaceFile(state, { path: "labs/output/REPORT.md" });

    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews.at(-1)?.content?.kind).toBe("unavailable"),
    );
    expect(listFiles).not.toHaveBeenCalled();
  });
});
