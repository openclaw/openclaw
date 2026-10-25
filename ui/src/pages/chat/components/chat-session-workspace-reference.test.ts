import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { createSessionCapabilityFixture } from "../chat-pane.test-support.ts";
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

const currentSession = "agent:main:current";
const fileError = (type = "not_found") =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: `session file ${type === "too_large" ? "too large" : "not found"}`,
    details: { type: `session_file_${type}`, ...(type === "too_large" ? { size: 4096 } : {}) },
  });
const entry = (path: string, kind = "file") => ({ path, name: path.split("/").at(-1)!, kind });
const listing = (entries: ReturnType<typeof entry>[], search = "REPORT.md", truncated = false) =>
  vi.fn().mockResolvedValue({
    sessionKey: currentSession,
    root: "/workspace",
    files: [],
    browser: { path: "", search, entries, truncated },
  });

describe("session workspace file reference resolution", () => {
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
    ["REPORT.md", "nested/REPORT.md", true],
    ["/workspace/src/readme.md", "src/readme.md", false],
  ] as const)(
    "resolves %s and keeps its root-qualified action path",
    async (inputPath, returnedPath, search) => {
      const requestPath = `/workspace/${returnedPath}`;
      const name = returnedPath.split("/").at(-1)!;
      const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(
        async (sessionKey, path) => {
          if (path !== requestPath) {
            throw fileError();
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
              content: "# Readme",
              hash: "hash",
            },
          };
        },
      );
      const listFiles = listing([entry(returnedPath)], name);
      const setFile = vi.fn<SessionWorkspaceHost["sessions"]["setFile"]>(async (sessionKey, path) =>
        getFile(sessionKey, path, { agentId: "main" }),
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
      expect(getFile.mock.calls.at(-1)?.[1]).toBe(requestPath);
      if (sidebarContent.kind !== "file" || !sidebarContent.edit) {
        throw new Error("expected editable resolved file content");
      }
      expect(sidebarContent.path).toBe(returnedPath);
      expect(sidebarContent.sessionFileSource).toEqual({
        sessionKey: currentSession,
        agentId: "main",
        path: requestPath,
      });
      await sidebarContent.edit.save({ content: "# Updated", expectedHash: "hash" });
      expect(setFile.mock.calls.at(-1)?.[1]).toBe(requestPath);
      await sidebarContent.download?.(new AbortController().signal);
      expect(downloadSessionFile).toHaveBeenLastCalledWith(
        state,
        { sessionKey: currentSession, agentId: "main", path: requestPath },
        expect.any(AbortSignal),
      );
      getFile.mockClear();
      await sidebarContent.edit.fetchLatest();
      expect(getFile.mock.calls.at(-1)?.[1]).toBe(requestPath);
    },
  );

  it("uses the resolved nested path for oversized-file metadata", async () => {
    const nestedPath = "labs/output/REPORT.md";
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(
      async (_sessionKey, path) => {
        throw fileError(path === `/workspace/${nestedPath}` ? "too_large" : "not_found");
      },
    );
    const listFiles = listing([entry(nestedPath)]);
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
    ["REPORT.md", [entry("a/REPORT.md"), entry("b/REPORT.md")], false],
    ["REPORT.md", [entry("a/REPORT.md")], true],
    ["REPORT.md", [entry("a/REPORT.md", "directory")], false],
    ["labs/output/REPORT.md", [], false],
  ] as const)("rejects unresolved %s (%j, truncated=%s)", async (path, entries, truncated) => {
    const getFile = vi.fn().mockRejectedValue(fileError());
    const listFiles = listing([...entries], "REPORT.md", truncated);
    const state = createReferenceState(createSessionCapabilityFixture({ getFile, listFiles }));

    void openSessionWorkspaceFile(state, { path });

    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews.at(-1)?.content?.kind).toBe("unavailable"),
    );
    expect(listFiles).toHaveBeenCalledTimes(path === "REPORT.md" ? 1 : 0);
    expect(getFile).toHaveBeenCalledExactlyOnceWith("agent:main:current", path, {
      agentId: "main",
    });
  });
});
