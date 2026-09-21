import { html } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  readPanelHostedTabs,
} from "../../../components/panel-hosted-tabs.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import {
  openSessionWorkspacePreview,
  closeSessionWorkspacePreview,
  selectSessionWorkspacePreview,
  getSessionWorkspace,
  loadSessionWorkspace,
} from "./chat-session-workspace-state.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";
import "./chat-files-panel.ts";

function host(): SessionWorkspaceHost {
  return {
    sessionKey: "agent:main:files",
    connectionEpoch: 1,
    connected: true,
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
    hello: null,
    sidebarContent: null,
    handleOpenSidebar: vi.fn(),
    requestUpdate: vi.fn(),
  };
}
afterEach(() => document.body.replaceChildren());
describe("workspace file tabs", () => {
  it("revalidates a clean file on explicit reopen without replacing its tab", async () => {
    const state = host();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: state.sessionKey,
      file: { name: "notes.md", path: "notes.md", content: "OLD", hash: "old" },
    });
    state.sessions.getFile = getFile;
    openSessionWorkspaceFile(state, { path: "notes.md" });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content).toMatchObject({ content: "OLD" }),
    );
    const preview = getSessionWorkspace(state).previews[0]!;
    getFile.mockResolvedValue({
      sessionKey: state.sessionKey,
      file: { name: "notes.md", path: "notes.md", content: "NEW", hash: "new" },
    });
    openSessionWorkspaceFile(state, { path: "notes.md", line: 2 });
    await vi.waitFor(() =>
      expect(preview.content).toMatchObject({ content: "NEW", navigation: { line: 2 } }),
    );
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
    expect(getSessionWorkspace(state).activePreviewId).toBe(preview.id);
  });

  it.each(["before reopen", "during read"])("preserves a draft created %s", async (timing) => {
    const state = host();
    const initial = {
      sessionKey: state.sessionKey,
      file: { name: "draft.md", path: "draft.md", content: "OLD", hash: "old" },
    };
    let resolveRead!: (result: typeof initial) => void;
    const getFile = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );
    state.sessions.getFile = getFile;
    openSessionWorkspaceFile(state, { path: "draft.md" });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
    );
    const preview = getSessionWorkspace(state).previews[0]!;
    const content = preview.content;
    if (content.kind !== "file") {
      throw new Error("Expected file preview");
    }
    try {
      if (timing === "before reopen") {
        setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
      }
      openSessionWorkspaceFile(state, { path: "draft.md" });
      if (timing === "during read") {
        await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
        setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
        resolveRead({ ...initial, file: { ...initial.file, content: "NEW", hash: "new" } });
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      } else {
        expect(getFile).toHaveBeenCalledTimes(1);
      }
      expect(preview.content).toBe(content);
      expect(readFileDraft(content)?.content).toBe("UNSAVED");
    } finally {
      setFileDraft(content, null);
    }
  });

  it.each(["session", "connection", "closed"])(
    "ignores a revalidation after its %s changes",
    async (change) => {
      const state = host();
      const initial = {
        sessionKey: state.sessionKey,
        file: { name: "stale.md", path: "stale.md", content: "OLD" },
      };
      let resolveRead!: (result: typeof initial) => void;
      const getFile = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveRead = resolve;
            }),
        );
      state.sessions.getFile = getFile;
      openSessionWorkspaceFile(state, { path: "stale.md" });
      await vi.waitFor(() =>
        expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
      );
      const preview = getSessionWorkspace(state).previews[0]!;
      const content = preview.content;
      openSessionWorkspaceFile(state, { path: "stale.md" });
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
      if (change === "session") {
        state.sessionKey = "agent:main:other";
      }
      if (change === "connection") {
        state.connectionEpoch += 1;
      }
      if (change === "closed") {
        closeSessionWorkspacePreview(state, preview.id);
      }
      const workspace = getSessionWorkspace(state);
      resolveRead({ ...initial, file: { ...initial.file, content: "STALE" } });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(preview.content).toBe(content);
      expect(workspace.previews).toEqual([]);
    },
  );

  it.each([
    ["notes.md", "older first", false, false],
    ["notes.md", "newer first", false, false],
    ["./notes.md", "older first", false, false],
    ["./notes.md", "newer first", false, false],
    ["notes.md", "older first", true, false],
    ["notes.md", "newer first", true, false],
    ["notes.md", "older first", true, true],
  ] as const)(
    "keeps latest alias intent after %s with %s (failed=%s, unrelated=%s)",
    async (olderPath, order, failed, unrelatedError) => {
      const state = host();
      const response = {
        sessionKey: state.sessionKey,
        root: "/workspace",
        file: { name: "notes.md", path: "notes.md", workspacePath: "notes.md", content: "CURRENT" },
      };
      const pending = new Map<
        string,
        { resolve: (value: typeof response) => void; reject: (error: Error) => void }
      >();
      state.sessions.getFile = vi
        .fn()
        .mockResolvedValueOnce(response)
        .mockImplementation(
          (_key, path: string) =>
            new Promise((resolve, reject) => {
              pending.set(path, { resolve, reject });
            }),
        );
      openSessionWorkspaceFile(state, { path: "notes.md" });
      await vi.waitFor(() =>
        expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
      );
      const retained = getSessionWorkspace(state).previews[0]!;
      openSessionWorkspaceFile(state, { path: olderPath });
      openSessionWorkspaceFile(state, { path: "/workspace/notes.md" });
      const older = () => {
        const request = pending.get(olderPath)!;
        if (failed) {
          request.reject(new Error("Temporary read failure"));
        } else {
          request.resolve({ ...response, file: { ...response.file, content: "OLD" } });
        }
      };
      const newer = () => pending.get("/workspace/notes.md")!.resolve(response);
      if (order === "older first") {
        older();
      } else {
        newer();
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      if (unrelatedError) {
        state.sessions.listFiles = vi.fn().mockRejectedValue(new Error("List failed"));
        loadSessionWorkspace(state, getSessionWorkspace(state), true);
        await vi.waitFor(() => expect(getSessionWorkspace(state).error).toBe("List failed"));
      }
      if (order === "older first") {
        newer();
      } else {
        older();
      }
      await vi.waitFor(() => expect(getSessionWorkspace(state).previews).toEqual([retained]));
      expect(retained.content).toMatchObject({ content: "CURRENT" });
      expect(getSessionWorkspace(state).error).toBe(unrelatedError ? "List failed" : null);
    },
  );

  it.each([
    ["README.md", "/workspace/README.md", false],
    ["/workspace/README.md", "README.md", false],
    ["README.md", "/workspace/README.md", true],
    ["/workspace/README.md", "README.md", true],
  ] as const)("reconciles %s and %s with dirty=%s", async (firstPath, aliasPath, dirty) => {
    const state = host();
    const response: SessionWorkspaceGetResult = {
      sessionKey: state.sessionKey,
      root: "/workspace",
      file: {
        name: "README.md",
        path: "README.md",
        workspacePath: "README.md",
        kind: "read",
        missing: false,
        previewKind: "text",
        contentEncoding: "utf8",
        content: "Original buffer",
      },
    };
    const getFile = vi.fn().mockResolvedValue(response);
    state.sessions.getFile = getFile;
    openSessionWorkspaceFile(state, { path: firstPath, line: 2 });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
    );
    const retained = getSessionWorkspace(state).previews[0]!;
    const originalContent = retained.content;
    if (originalContent.kind !== "file") {
      throw new Error("Expected file preview");
    }
    if (dirty) {
      setFileDraft(originalContent, { content: "Unsaved buffer", expectedHash: "original" });
      onTestFinished(() => setFileDraft(originalContent, null));
    }
    getFile.mockResolvedValue({
      ...response,
      file: { ...response.file, content: "New disk buffer" },
    });
    openSessionWorkspaceFile(state, { path: aliasPath, line: 7 });
    await vi.waitFor(() => expect(getSessionWorkspace(state).previews).toEqual([retained]));
    expect(retained.content).toMatchObject({
      content: dirty ? "Original buffer" : "New disk buffer",
      navigation: { line: 7 },
    });
    if (dirty) {
      expect(retained.content).toBe(originalContent);
      expect(readFileDraft(originalContent)?.content).toBe("Unsaved buffer");
    }
    expect(getSessionWorkspace(state).activePreviewId).toBe(retained.id);
    openSessionWorkspaceFile(state, { path: aliasPath, line: 9 });
    expect(getFile).toHaveBeenCalledTimes(dirty ? 2 : 3);
    expect(retained.content).toMatchObject({ navigation: { line: 9 } });
    closeSessionWorkspacePreview(state, retained.id);
    openSessionWorkspaceFile(state, { path: aliasPath });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
    );
    expect(getFile).toHaveBeenCalledTimes(dirty ? 3 : 4);
  });

  it("merges late aliases without stealing selection or replacing newer line intent", async () => {
    const state = host();
    const pending = new Map<string, (value: SessionWorkspaceGetResult) => void>();
    const getFile = vi.fn(
      (_key: string, path: string) =>
        new Promise<SessionWorkspaceGetResult>((resolve) => {
          pending.set(path, resolve);
        }),
    );
    state.sessions.getFile = getFile;
    const response: SessionWorkspaceGetResult = {
      sessionKey: state.sessionKey,
      root: "/workspace",
      file: {
        name: "README.md",
        path: "README.md",
        workspacePath: "README.md",
        kind: "read",
        missing: false,
        content: "File contents",
      },
    };
    openSessionWorkspaceFile(state, { path: "README.md", line: 2 });
    openSessionWorkspaceFile(state, { path: "/workspace/README.md", line: 7 });
    pending.get("/workspace/README.md")!(response);
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[1]?.content.kind).toBe("file"),
    );
    const retained = getSessionWorkspace(state).previews[1]!;
    openSessionWorkspacePreview(state, "attachment:other", "other.txt", {
      kind: "markdown",
      content: "Other",
    });
    pending.get("README.md")!(response);
    await vi.waitFor(() => expect(getSessionWorkspace(state).previews).toHaveLength(2));
    expect(getSessionWorkspace(state).previews[0]).toBe(retained);
    expect(getSessionWorkspace(state).activePreviewId).toBe("attachment:other");
    expect(retained.content).toMatchObject({ navigation: { line: 7 } });
    openSessionWorkspaceFile(state, { path: "README.md", line: 9 });
    expect(getFile).toHaveBeenCalledTimes(3);
    expect(getSessionWorkspace(state).activePreviewId).toBe(retained.id);
    expect(retained.content).toMatchObject({ navigation: { line: 9 } });
  });

  it.each(["image", "unsupported"] as const)(
    "reconciles canonical aliases for %s previews",
    async (previewKind) => {
      const state = host();
      const response: SessionWorkspaceGetResult = {
        sessionKey: state.sessionKey,
        root: "/workspace",
        file: {
          name: "asset.png",
          path: "asset.png",
          workspacePath: "asset.png",
          kind: "read",
          missing: false,
          previewKind,
          ...(previewKind === "image"
            ? { mimeType: "image/png", contentEncoding: "base64" as const, content: "iVBORw0KGgo=" }
            : { mimeType: "application/octet-stream", size: 512 }),
        },
      };
      state.sessions.getFile = vi.fn().mockResolvedValue(response);
      openSessionWorkspaceFile(state, { path: "asset.png" });
      await vi.waitFor(() =>
        expect(getSessionWorkspace(state).previews[0]?.content.kind).not.toBe("loading"),
      );
      const original = getSessionWorkspace(state).previews[0]!;
      openSessionWorkspaceFile(state, { path: "/workspace/asset.png" });
      await vi.waitFor(() => expect(getSessionWorkspace(state).previews).toEqual([original]));
      expect(getSessionWorkspace(state).activePreviewId).toBe(original.id);
      vi.mocked(state.sessions.getFile).mockResolvedValue({
        ...response,
        file: { ...response.file, content: "TkVX", size: 1024 },
      });
      openSessionWorkspaceFile(state, { path: "asset.png" });
      await vi.waitFor(() =>
        expect(original.content).toMatchObject(
          previewKind === "image"
            ? { src: "data:image/png;base64,TkVX" }
            : { rawText: expect.stringContaining("1,024 bytes") },
        ),
      );
      expect(getSessionWorkspace(state).previews).toEqual([original]);
    },
  );

  it("scopes main-view tab and content IDs to each panel and keeps them stable", async () => {
    const panels = [0, 1].map(() => {
      const panel = document.createElement("openclaw-chat-files-panel");
      panel.tabsInHeader = false;
      panel.activeId = "file:same.ts";
      panel.previews = [
        { id: "file:same.ts", label: "same.ts", content: { kind: "markdown", content: "same" } },
      ];
      document.body.append(panel);
      return panel;
    });
    await Promise.all(panels.map((panel) => panel.updateComplete));
    const tabs = panels.map((panel) => panel.querySelector<HTMLElement>("wa-tab")!);
    const ids = tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(2);
    for (const [index, panel] of panels.entries()) {
      const tab = tabs[index]!;
      const content = panel.querySelector(".chat-files-panel__content")!;
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBe(content);
      panel.requestUpdate();
      await panel.updateComplete;
      expect(panel.querySelector("wa-tab")?.id).toBe(ids[index]);
    }
  });

  it("does not recover sibling focus when the other pane loses its active tab", async () => {
    const panels = [0, 1].map(() => {
      const panel = document.createElement("openclaw-chat-files-panel");
      panel.tabsInHeader = false;
      panel.activeId = "file:same.ts";
      panel.previews = [
        { id: "file:same.ts", label: "same.ts", content: { kind: "markdown", content: "same" } },
      ];
      document.body.append(panel);
      return panel;
    });
    await Promise.all(panels.map((panel) => panel.updateComplete));
    await Promise.resolve();
    const firstTab = panels[0]!.querySelector<HTMLElement>("wa-tab")!;
    const siblingTab = panels[1]!.querySelector<HTMLElement>("wa-tab")!;
    firstTab.focus();
    expect(document.activeElement).toBe(firstTab);
    panels[1]!.requestUpdate();
    // Mirror the shared strip's keyed-movement focus-loss window after render
    // records the active element but before its queued recovery executes.
    queueMicrotask(() => firstTab.blur());
    await panels[1]!.updateComplete;
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).not.toBe(siblingTab);
  });

  it("uses the newest explicit line when the same file is reopened during its read", async () => {
    const state = host();
    let resolve!: (value: unknown) => void;
    state.sessions.getFile = vi.fn().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    openSessionWorkspaceFile(state, { path: "pending.ts", line: 2 });
    openSessionWorkspaceFile(state, { path: "pending.ts", line: 7 });
    resolve({
      sessionKey: state.sessionKey,
      file: { name: "pending.ts", path: "pending.ts", content: "one\ntwo" },
    });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content).toMatchObject({
        kind: "file",
        line: 7,
      }),
    );
    expect(state.sessions.getFile).toHaveBeenCalledOnce();
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
  });

  it("deduplicates stable identities, closes only the selected preview, and scopes tabs to reconnect", () => {
    const state = host();
    const first = openSessionWorkspacePreview(state, "file:a", "a.txt", {
      kind: "markdown",
      content: "A",
    });
    openSessionWorkspacePreview(state, "file:b", "b.txt", { kind: "markdown", content: "B" });
    expect(openSessionWorkspacePreview(state, "file:a", "a.txt", { kind: "loading" })).toBe(first);
    expect(getSessionWorkspace(state).previews).toHaveLength(2);
    closeSessionWorkspacePreview(state, "file:a");
    expect(getSessionWorkspace(state).activePreviewId).toBe("file:b");
    selectSessionWorkspacePreview(state, null);
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
    state.connectionEpoch++;
    expect(getSessionWorkspace(state).previews).toEqual([]);
  });

  it("settles background file reads without selecting them and rejects closed requests", async () => {
    const state = host();
    let resolve!: (value: unknown) => void;
    state.sessions.getFile = vi.fn().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    openSessionWorkspaceFile(state, { path: "a.txt" });
    openSessionWorkspacePreview(state, "attachment:b", "b.txt", {
      kind: "attachment",
      title: "b.txt",
      src: "/media/b.txt",
    });
    resolve({
      sessionKey: state.sessionKey,
      root: "/workspace",
      file: {
        name: "a.txt",
        path: "a.txt",
        content: "A",
        previewKind: "text",
        contentEncoding: "utf8",
      },
    });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
    );
    expect(getSessionWorkspace(state).activePreviewId).toBe("attachment:b");
    openSessionWorkspaceFile(state, { path: "c.txt" });
    closeSessionWorkspacePreview(state, "file:c.txt");
    resolve({ sessionKey: state.sessionKey, file: { name: "c.txt", path: "c.txt", content: "C" } });
    await Promise.resolve();
    expect(getSessionWorkspace(state).previews.map((entry) => entry.id)).toEqual([
      "file:a.txt",
      "attachment:b",
    ]);
  });

  it("retries an unavailable file without duplicating its tab", async () => {
    const state = host();
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        sessionKey: state.sessionKey,
        file: { name: "retry.txt", path: "retry.txt", content: "Ready" },
      });
    state.sessions.getFile = getFile;
    openSessionWorkspaceFile(state, { path: "retry.txt" });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("unavailable"),
    );
    openSessionWorkspaceFile(state, { path: "retry.txt" });
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file"),
    );
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("projects the shared hosted-tab contract and keeps inactive preview elements mounted", async () => {
    const state = host();
    const a = openSessionWorkspacePreview(state, "a", "a.md", { kind: "markdown", content: "A" });
    openSessionWorkspacePreview(state, "b", "b.txt", { kind: "markdown", content: "B" });
    const panel = document.createElement("openclaw-chat-files-panel");
    Object.assign(panel, {
      previews: getSessionWorkspace(state).previews,
      activeId: "a",
      renderDetail: () => html`<textarea>draft</textarea>`,
      onSelect: (id: string | null) => selectSessionWorkspacePreview(state, id),
      onClose: (id: string) => closeSessionWorkspacePreview(state, id),
    });
    document.body.append(panel);
    await panel.updateComplete;
    const textarea = panel.querySelector("textarea")!;
    textarea.value = "unsaved";
    const hosted = readPanelHostedTabs(panel)!;
    expect(hosted.hostedTabs.map((tab) => tab.label)).toEqual(["a.md", "b.txt"]);
    hosted.selectHostedTab("b");
    panel.activeId = "b";
    await panel.updateComplete;
    expect(panel.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("unsaved");
    expect(panel.querySelector("wa-tab-group")).toBeNull();
    panel.tabsInHeader = false;
    await panel.updateComplete;
    expect(panel.querySelectorAll("wa-tab-group")).toHaveLength(1);
    expect(panel.querySelectorAll("wa-tab")).toHaveLength(2);
    panel.tabsInHeader = true;
    await panel.updateComplete;
    expect(panel.querySelector("wa-tab-group")).toBeNull();
    expect(panel.querySelector("textarea")).toBe(textarea);
    await hosted.closeHostedTab("a");
    expect(getSessionWorkspace(state).previews).not.toContain(a);
  });

  it("announces hosted-tab changes without invalidating the header for file content updates", async () => {
    const panel = document.createElement("openclaw-chat-files-panel");
    const changed = vi.fn();
    panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    panel.previews = [{ id: "notes", label: "notes.md", content: { kind: "loading" } }];
    panel.activeId = "notes";
    document.body.append(panel);
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledOnce();

    panel.browser = html`<div>Refreshed workspace</div>`;
    panel.renderDetail = () => html`<div>File contents</div>`;
    panel.onSelect = vi.fn();
    panel.onClose = vi.fn();
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledOnce();

    const file = {
      kind: "file" as const,
      name: "notes.md",
      path: "notes.md",
      content: "Initial contents",
    };
    panel.previews = [{ id: "notes", label: "notes.md", content: file }];
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(2);
    expect(panel.hostedTabs[0]?.className).toBeUndefined();

    file.content = "Updated contents";
    panel.requestUpdate();
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(2);

    file.path = "docs/notes.md";
    panel.requestUpdate();
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(3);
    expect(panel.hostedTabs[0]?.title).toBe("docs/notes.md");

    panel.previews = [{ id: "notes", label: "renamed.md", content: file }];
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(4);
    expect(panel.hostedTabs[0]?.label).toBe("renamed.md");

    panel.activeId = null;
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(5);
    expect(panel.activeHostedTabId).toBe("browse");

    panel.previews = [];
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(6);
    expect(panel.hostedTabs).toEqual([]);
  });
});
