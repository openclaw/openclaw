import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  loadedSidebarContent,
  createSidebarContentRecorder,
} from "./chat-session-workspace.test-support.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";

describe("workspace file source identity", () => {
  it.each(["workspaceId", "root", "fileRoot"] as const)(
    "binds saves, conflict reloads, and reopened drafts to the original %s",
    async (field) => {
      const original = { workspaceId: "managed-a", root: "/workspace", fileRoot: "/workspace" };
      let source = original;
      const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
        sessionKey,
        root: "/workspace",
        source,
        file: {
          name: "notes.md",
          path: "notes.md",
          workspacePath: "notes.md",
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content: "original notes",
          hash: "same-hash",
        },
      }));
      const setFile = vi.fn<SessionWorkspaceHost["sessions"]["setFile"]>().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Workspace changed",
          details: { type: "session_file_source_changed" },
        }),
      );
      const listFiles = vi.fn<SessionWorkspaceHost["sessions"]["listFiles"]>(
        async (sessionKey) => ({
          sessionKey,
          root: source.root,
          files: [],
        }),
      );
      const state: SessionWorkspaceHost = {
        client: createGatewayBrowserClientFixture(),
        connected: true,
        connectionEpoch: 1,
        handleOpenSidebar: createSidebarContentRecorder(),
        hello: gatewayHelloForMethods(["sessions.files.set"]),
        sessionKey: "agent:main:current",
        sidebarContent: null,
        requestUpdate: vi.fn(),
        sessions: createSessionCapabilityFixture({ getFile, setFile, listFiles }),
      };
      openSessionWorkspaceFile(state, { path: "notes.md" });
      const file = await loadedSidebarContent(state);
      if (file.kind !== "file" || !file.edit) {
        throw new Error("Expected editable file");
      }
      expect(await file.edit.fetchLatest()).toMatchObject({
        content: "original notes",
        hash: "same-hash",
      });
      source = { ...original, [field]: original[field] + "-replacement" };
      expect(await file.edit.fetchLatest()).toBeNull();
      expect(
        await file.edit.save({ content: "retained draft", expectedHash: "same-hash" }),
      ).toMatchObject({ ok: false, code: "error", message: "Workspace changed" });
      expect(setFile).toHaveBeenLastCalledWith(state.sessionKey, "notes.md", "retained draft", {
        agentId: "main",
        expectedHash: "same-hash",
        expectedSource: original,
      });
      expect(listFiles).toHaveBeenCalledOnce();
      expect(state.sessionWorkspaceState?.previews[0]?.content).toBe(file);
      openSessionWorkspaceFile(state, { path: "notes.md" });
      await vi.waitFor(() =>
        expect(state.sessionWorkspaceState?.previews[0]?.content).not.toBe(file),
      );
      const fresh = await loadedSidebarContent(state);
      if (fresh.kind !== "file" || !fresh.edit) {
        throw new Error("Expected reopened file");
      }
      expect(fresh.draftKey).not.toBe(file.draftKey);
      await fresh.edit.save({ content: "fresh draft", expectedHash: "same-hash" });
      expect(setFile).toHaveBeenLastCalledWith(state.sessionKey, "notes.md", "fresh draft", {
        agentId: "main",
        expectedHash: "same-hash",
        expectedSource: source,
      });
    },
  );

  it.each(["forwarded", "navigated"] as const)(
    "does not refresh a different listing after a %s source-change refusal",
    async (view) => {
      const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
        sessionKey,
        root: "/workspace",
        source: { workspaceId: "managed-a", root: "/workspace", fileRoot: "/workspace" },
        file: {
          name: "notes.md",
          path: "notes.md",
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content: "notes",
          hash: "same-hash",
        },
      }));
      const setFile = vi.fn<SessionWorkspaceHost["sessions"]["setFile"]>().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Workspace changed",
          details: { type: "session_file_source_changed" },
        }),
      );
      const listFiles = vi.fn<SessionWorkspaceHost["sessions"]["listFiles"]>();
      const state: SessionWorkspaceHost = {
        client: createGatewayBrowserClientFixture(),
        connected: true,
        connectionEpoch: 1,
        handleOpenSidebar: createSidebarContentRecorder(),
        hello: gatewayHelloForMethods(["sessions.files.set"]),
        sessionKey: "agent:main:current",
        sidebarContent: null,
        requestUpdate: vi.fn(),
        sessions: createSessionCapabilityFixture({ getFile, setFile, listFiles }),
      };
      openSessionWorkspaceFile(state, {
        path: "notes.md",
        ...(view === "forwarded" ? { sessionKey: "agent:main:other" } : {}),
      });
      const file = await loadedSidebarContent(state);
      if (file.kind !== "file" || !file.edit) {
        throw new Error("Expected editable file");
      }
      const saving = file.edit.save({ content: "draft", expectedHash: "same-hash" });
      if (view === "navigated") {
        state.sessionKey = "agent:main:next";
      }
      expect(await saving).toMatchObject({ ok: false, code: "error" });
      expect(listFiles).not.toHaveBeenCalled();
    },
  );
});
