import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
import { createSessionWorkspaceHost } from "./chat-session-workspace-host.test-support.ts";
import {
  createSidebarContentRecorder,
  loadedSidebarContent,
} from "./chat-session-workspace.test-support.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";

const downloadSessionFile = vi.hoisted(() =>
  vi.fn(async () => ({ url: "/download/report", filename: "REPORT.md" })),
);

vi.mock("../../../api/session-file-download.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/session-file-download.ts")>();
  return { ...actual, downloadSessionFile };
});

function createReferenceState(
  sessions: SessionWorkspaceHost["sessions"],
  methods: string[] = ["sessions.files.list", "sessions.files.set"],
): SessionWorkspaceHost {
  return createSessionWorkspaceHost({
    handleOpenSidebar: createSidebarContentRecorder(),
    hello: gatewayHelloForMethods(methods),
    sessionKey: "agent:main:current",
    sessions,
  });
}

describe("session workspace file reference resolution", () => {
  it.each(["application/pdf", "application/octet-stream"])(
    "previews only detected PDFs and retains message-qualified downloads (%s)",
    async (mimeType) => {
      const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
        sessionKey,
        root: "/original-workspace",
        file: {
          path: "report.pdf",
          workspacePath: "reports/report.pdf",
          name: "report.pdf",
          kind: "read",
          missing: false,
          previewKind: "unsupported",
          mimeType,
          size: 300_000,
        },
      }));
      const state = createReferenceState(createSessionCapabilityFixture({ getFile }));
      const target = {
        path: "report.pdf",
        sessionKey: "agent:other:original",
        messageEntryId: "original-message",
      };
      await openSessionWorkspaceFile(state, target);
      const content = await loadedSidebarContent(state);
      expect(content.kind).toBe(mimeType === "application/pdf" ? "attachment" : "markdown");
      if (content.kind !== "attachment" && content.kind !== "markdown") {
        throw new Error("Expected a PDF preview or unsupported-file fallback");
      }
      expect(content.file).toMatchObject({
        path: "reports/report.pdf",
        absolutePath: "/original-workspace/reports/report.pdf",
        root: "/original-workspace",
      });
      await content.file!.download(new AbortController().signal);
      expect(downloadSessionFile).toHaveBeenLastCalledWith(
        state,
        {
          sessionKey: target.sessionKey,
          agentId: "other",
          path: "/original-workspace/reports/report.pdf",
          messageEntryId: target.messageEntryId,
        },
        expect.any(AbortSignal),
      );
    },
  );

  it("preserves a null file-capability result as an unavailable preview", async () => {
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async () => null);
    const listFiles = vi.fn();
    const state = createReferenceState(createSessionCapabilityFixture({ getFile, listFiles }), []);

    void openSessionWorkspaceFile(state, { path: "REPORT.md" });

    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toEqual({
        kind: "unavailable",
        message: "Failed to load REPORT.md",
      }),
    );
    expect(getFile).toHaveBeenCalledExactlyOnceWith("agent:main:current", "REPORT.md", {
      agentId: "main",
    });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "resolves a bare filename to the nested workspace file that search finds once",
      inputPath: "ORGANIZATION_REPORT.md",
      returnedPath: "labs/file-organizer/output/sorted-copy-001/ORGANIZATION_REPORT.md",
      search: true,
      content: "# Sorted",
    },
    {
      label:
        "keeps the successful root path for actions when the Gateway responds with a cwd-relative path",
      inputPath: "/workspace/src/readme.md",
      returnedPath: "src/readme.md",
      search: false,
      content: "# Readme",
    },
    {
      label:
        "uses the returned workspace file for actions after opening a sandbox-absolute reference",
      inputPath: "/sandbox/src/readme.md",
      returnedPath: "src/readme.md",
      search: false,
      content: "# Readme",
    },
  ])("$label", async ({ inputPath, returnedPath, search, content }) => {
    const requestPath = `/workspace/${returnedPath}`;
    const name = returnedPath.split("/").at(-1)!;
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey, path) => {
      if (path !== requestPath && (search || path !== inputPath)) {
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
          path: returnedPath,
          workspacePath: returnedPath,
          name,
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content,
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
        search: name,
        entries: [{ path: returnedPath, name, kind: "file" }],
      },
    });
    const setFile = vi.fn<SessionWorkspaceHost["sessions"]["setFile"]>(
      async (sessionKey, path) => ({
        sessionKey,
        file: {
          path,
          workspacePath: path,
          name: path.split("/").at(-1) ?? path,
          kind: "modified",
          missing: false,
          hash: "saved-hash",
        },
      }),
    );
    const state = createReferenceState(
      createSessionCapabilityFixture({ getFile, listFiles, setFile }),
    );

    void openSessionWorkspaceFile(state, { path: inputPath });

    const sidebarContent = await loadedSidebarContent(state);
    if (search) {
      expect(listFiles).toHaveBeenCalledExactlyOnceWith("agent:main:current", {
        agentId: "main",
        path: "",
        search: name,
      });
    } else {
      expect(listFiles).not.toHaveBeenCalled();
    }
    expect(getFile).toHaveBeenLastCalledWith(
      "agent:main:current",
      search ? requestPath : inputPath,
      {
        agentId: "main",
      },
    );
    if (sidebarContent.kind !== "file" || !sidebarContent.edit) {
      throw new Error("expected editable resolved file content");
    }
    expect(sidebarContent.path).toBe(returnedPath);
    await sidebarContent.edit.save({ content: "# Updated", expectedHash: "hash" });
    expect(setFile).toHaveBeenLastCalledWith("agent:main:current", requestPath, "# Updated", {
      agentId: "main",
      expectedHash: "hash",
    });
    expect(sidebarContent.sessionFileSource).toEqual({
      sessionKey: "agent:main:current",
      agentId: "main",
      path: requestPath,
    });
    await sidebarContent.download?.(new AbortController().signal);
    expect(downloadSessionFile).toHaveBeenLastCalledWith(
      state,
      { sessionKey: "agent:main:current", agentId: "main", path: requestPath },
      expect.any(AbortSignal),
    );
    await sidebarContent.edit.fetchLatest();
    expect(getFile).toHaveBeenLastCalledWith("agent:main:current", requestPath, {
      agentId: "main",
    });
  });

  it("uses the resolved nested path for oversized-file metadata", async () => {
    const nestedPath = "labs/output/REPORT.md";
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey, path) => {
      if (path === `/workspace/${nestedPath}`) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session file too large",
          details: { type: "session_file_too_large", size: 4096 },
        });
      }
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "session file not found",
        details: { type: "session_file_not_found" },
      });
    });
    const listFiles = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      files: [],
      browser: {
        path: "",
        search: "REPORT.md",
        entries: [{ path: nestedPath, name: "REPORT.md", kind: "file" }],
      },
    });
    const state = createReferenceState(createSessionCapabilityFixture({ getFile, listFiles }));

    void openSessionWorkspaceFile(state, { path: "REPORT.md" });

    const sidebarContent = await loadedSidebarContent(state);
    if (sidebarContent.kind !== "markdown") {
      throw new Error("expected Markdown preview for REPORT.md");
    }
    expect(sidebarContent.fileDownload?.path).toBe(`/workspace/${nestedPath}`);
    expect(sidebarContent.rawText).toContain(`/workspace/${nestedPath}`);
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
    const state = createReferenceState(createSessionCapabilityFixture({ getFile, listFiles }));

    void openSessionWorkspaceFile(state, { path: "REPORT.md" });

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
    const state = createReferenceState(createSessionCapabilityFixture({ getFile, listFiles }));

    void openSessionWorkspaceFile(state, { path: "labs/output/REPORT.md" });

    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews.at(-1)?.content?.kind).toBe("unavailable"),
    );
    expect(listFiles).not.toHaveBeenCalled();
  });
});
