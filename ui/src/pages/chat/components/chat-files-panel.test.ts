import { createEffect } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import { registerMcpAppUnmountTarget } from "../../../components/mcp-app-unmount.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  readPanelHostedTabs,
} from "../../../components/panel-hosted-tabs.ts";
import { installResizeObserverStub } from "../../../test-helpers/resize-observer.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import {
  openSessionWorkspacePreview,
  pinSessionWorkspacePreview,
  requestCloseSessionWorkspacePreview,
  selectSessionWorkspacePreview,
  getSessionWorkspace,
  loadSessionWorkspace,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SessionWorkspacePreview } from "./chat-sidebar-content-types.ts";
import "./chat-files-panel.tsx";

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
  };
}

function textResponse(
  state: SessionWorkspaceHost,
  path: string,
  content: string,
  fields: Partial<SessionWorkspaceGetResult["file"]> = {},
): SessionWorkspaceGetResult {
  return {
    sessionKey: state.sessionKey,
    file: {
      name: path,
      path,
      kind: "read",
      missing: false,
      previewKind: "text",
      contentEncoding: "utf8",
      content,
      ...fields,
    },
  };
}

function mountPanel() {
  const panel = document.createElement("openclaw-chat-files-panel");
  panel.tabsInHeader = false;
  panel.activeId = "file:same.ts";
  panel.previews = [
    { id: "file:same.ts", label: "same.ts", content: { kind: "markdown", content: "same" } },
  ];
  document.body.append(panel);
  return panel;
}

// Arm after synchronous open/close notifications and before settling a controlled read.
function nextWorkspaceUpdate(state: SessionWorkspaceHost) {
  const updated = createDeferred();
  const stop = sessionWorkspaceForHost(state).subscribe(() => updated.resolve());
  onTestFinished(stop);
  return updated.promise.finally(stop);
}

beforeEach(installResizeObserverStub);
afterEach(() => document.body.replaceChildren());
describe("workspace file tabs", () => {
  it("opens a file while the catalog refresh is pending", async () => {
    const state = host();
    const workspace = getSessionWorkspace(state);
    workspace.list = {
      sessionKey: state.sessionKey,
      root: "/workspace",
      files: [],
      browser: { path: "", entries: [{ name: "reports", path: "reports", kind: "directory" }] },
    };
    const pending = createDeferred<NonNullable<typeof workspace.list>>();
    state.sessions.listFiles = vi.fn().mockReturnValue(pending.promise);
    state.sessions.getFile = vi
      .fn()
      .mockResolvedValue(textResponse(state, "inventory.csv", "notebooks"));
    const panel = document.createElement("openclaw-chat-files-panel");
    panel.tabsInHeader = false;
    panel.presentation = "desktop";
    panel.renderDetail = ({ content }) =>
      content.kind === "file" ? content.content : content.kind;
    const sync = () => {
      panel.workspace = createSessionWorkspaceProps(state, { presentation: "desktop" });
      panel.previews = workspace.previews;
      panel.activeId = workspace.activePreviewId;
    };
    const stop = sessionWorkspaceForHost(state).subscribe(sync);
    onTestFinished(() => {
      stop();
      pending.resolve(workspace.list!);
    });
    sync();
    document.body.append(panel);
    await waitForSolid(() => expect(panel.textContent).toContain("reports"));
    loadSessionWorkspace(state, workspace);
    await waitForSolid(() => expect(state.sessions.listFiles).toHaveBeenCalledOnce());
    await openSessionWorkspaceFile(state, { path: "inventory.csv" });
    await waitForSolid(() => expect(panel.textContent).toContain("notebooks"));
    expect(
      panel.querySelector(".chat-files-panel__page:not(.chat-files-panel__catalog):not([hidden])")
        ?.textContent,
    ).toContain("notebooks");
    expect(panel.querySelector('button[aria-label="reports"]')).not.toBeNull();
  });

  it("revalidates a clean file on explicit reopen without replacing its tab", async () => {
    const state = host();
    const getFile = vi
      .fn()
      .mockResolvedValue(textResponse(state, "notes.md", "OLD", { hash: "old" }));
    state.sessions.getFile = getFile;
    void openSessionWorkspaceFile(state, { path: "notes.md" });
    await nextWorkspaceUpdate(state);
    expect(getSessionWorkspace(state).previews[0]?.content).toMatchObject({ content: "OLD" });
    const preview = getSessionWorkspace(state).previews[0]!;
    getFile.mockResolvedValue(textResponse(state, "notes.md", "NEW", { hash: "new" }));
    void openSessionWorkspaceFile(state, { path: "notes.md", line: 2 });
    await nextWorkspaceUpdate(state);
    expect(preview.content).toMatchObject({ content: "NEW", navigation: { line: 2 } });
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
    expect(getSessionWorkspace(state).activePreviewId).toBe(preview.id);
  });

  it.each(["before reopen", "during read"])("preserves a draft created %s", async (timing) => {
    const state = host();
    const initial = textResponse(state, "draft.md", "OLD", { hash: "old" });
    const read = createDeferred<SessionWorkspaceGetResult>();
    const getFile = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(read.promise);
    state.sessions.getFile = getFile;
    void openSessionWorkspaceFile(state, { path: "draft.md" });
    await nextWorkspaceUpdate(state);
    expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
    const preview = getSessionWorkspace(state).previews[0]!;
    const content = preview.content;
    if (content.kind !== "file") {
      throw new Error("Expected file preview");
    }
    try {
      if (timing === "before reopen") {
        setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
      }
      void openSessionWorkspaceFile(state, { path: "draft.md" });
      if (timing === "during read") {
        expect(getFile).toHaveBeenCalledTimes(2);
        setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
        const updated = nextWorkspaceUpdate(state);
        read.resolve({ ...initial, file: { ...initial.file, content: "NEW", hash: "new" } });
        await updated;
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
      const initial = textResponse(state, "stale.md", "OLD");
      const read = createDeferred<SessionWorkspaceGetResult>();
      const getFile = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(read.promise);
      state.sessions.getFile = getFile;
      void openSessionWorkspaceFile(state, { path: "stale.md" });
      await nextWorkspaceUpdate(state);
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
      const preview = getSessionWorkspace(state).previews[0]!;
      const content = preview.content;
      void openSessionWorkspaceFile(state, { path: "stale.md" });
      expect(getFile).toHaveBeenCalledTimes(2);
      if (change === "session") {
        state.sessionKey = "agent:main:other";
      }
      if (change === "connection") {
        state.connectionEpoch += 1;
      }
      if (change === "closed") {
        await requestCloseSessionWorkspacePreview(state, preview.id);
      }
      const workspace = getSessionWorkspace(state);
      read.resolve({ ...initial, file: { ...initial.file, content: "STALE" } });
      // Cross a browser task so all continuations of the retired read have settled.
      await new Promise<void>((resolve) => {
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
        ...textResponse(state, "notes.md", "CURRENT", { workspacePath: "notes.md" }),
        root: "/workspace",
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
      void openSessionWorkspaceFile(state, { path: "notes.md" });
      await nextWorkspaceUpdate(state);
      expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
      const retained = getSessionWorkspace(state).previews[0]!;
      void openSessionWorkspaceFile(state, { path: olderPath });
      void openSessionWorkspaceFile(state, { path: "/workspace/notes.md" });
      const older = () => {
        const request = pending.get(olderPath)!;
        if (failed) {
          request.reject(new Error("Temporary read failure"));
        } else {
          request.resolve({ ...response, file: { ...response.file, content: "OLD" } });
        }
      };
      const newer = () => pending.get("/workspace/notes.md")!.resolve(response);
      const firstUpdated = nextWorkspaceUpdate(state);
      if (order === "older first") {
        older();
      } else {
        newer();
      }
      await firstUpdated;
      if (unrelatedError) {
        state.sessions.listFiles = vi.fn().mockRejectedValue(new Error("List failed"));
        loadSessionWorkspace(state, getSessionWorkspace(state), true);
        await nextWorkspaceUpdate(state);
        expect(getSessionWorkspace(state).error).toBe("List failed");
      }
      const secondUpdated = nextWorkspaceUpdate(state);
      if (order === "older first") {
        newer();
      } else {
        older();
      }
      await secondUpdated;
      expect(getSessionWorkspace(state).previews).toEqual([retained]);
      expect(retained.content).toMatchObject({ content: "CURRENT" });
      expect(getSessionWorkspace(state).error).toBe(unrelatedError ? "List failed" : null);
    },
  );

  it("renders newer alias content before an older canonical read settles", async () => {
    const state = host();
    const initial = {
      ...textResponse(state, "notes.md", "INITIAL", { workspacePath: "notes.md" }),
      root: "/workspace",
    };
    const older = createDeferred<SessionWorkspaceGetResult>();
    const newer = createDeferred<SessionWorkspaceGetResult>();
    state.sessions.getFile = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const panel = document.createElement("openclaw-chat-files-panel");
    panel.renderDetail = (props) => {
      const node = document.createElement("div");
      createEffect(
        () => (props.content.kind === "file" ? props.content.content : ""),
        (value) => {
          node.textContent = value;
        },
      );
      return node;
    };
    const sync = () => {
      const workspace = getSessionWorkspace(state);
      panel.previews = workspace.previews;
      panel.activeId = workspace.activePreviewId;
    };
    const stop = sessionWorkspaceForHost(state).subscribe(sync);
    onTestFinished(() => {
      stop();
      older.resolve(initial);
    });
    document.body.append(panel);
    void openSessionWorkspaceFile(state, { path: "notes.md" });
    await waitForSolid(() => expect(panel.textContent).toContain("INITIAL"));
    const preview = getSessionWorkspace(state).previews[0]!;
    void openSessionWorkspaceFile(state, { path: "notes.md" });
    void openSessionWorkspaceFile(state, { path: "/workspace/notes.md" });
    newer.resolve({ ...initial, file: { ...initial.file, content: "CURRENT" } });
    await waitForSolid(() => expect(panel.textContent).toContain("CURRENT"));
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
    expect(state.sessions.getFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["README.md", "/workspace/README.md", false],
    ["/workspace/README.md", "README.md", true],
  ] as const)("reconciles %s and %s with dirty=%s", async (firstPath, aliasPath, dirty) => {
    const state = host();
    const response = {
      ...textResponse(state, "README.md", "Original buffer", { workspacePath: "README.md" }),
      root: "/workspace",
    };
    const getFile = vi.fn().mockResolvedValue(response);
    state.sessions.getFile = getFile;
    void openSessionWorkspaceFile(state, { path: firstPath, line: 2 });
    await nextWorkspaceUpdate(state);
    expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
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
    void openSessionWorkspaceFile(state, { path: aliasPath, line: 7 });
    await nextWorkspaceUpdate(state);
    expect(getSessionWorkspace(state).previews).toEqual([retained]);
    expect(retained.content).toMatchObject({
      content: dirty ? "Original buffer" : "New disk buffer",
      navigation: { line: 7 },
    });
    if (dirty) {
      expect(retained.content).toBe(originalContent);
      expect(readFileDraft(originalContent)?.content).toBe("Unsaved buffer");
    }
    expect(getSessionWorkspace(state).activePreviewId).toBe(retained.id);
    const revalidation = openSessionWorkspaceFile(state, { path: aliasPath, line: 9 });
    expect(getFile).toHaveBeenCalledTimes(dirty ? 2 : 3);
    expect(retained.content).toMatchObject({ navigation: { line: 9 } });
    // Finish the draft-retention scenario before exercising the public close path.
    setFileDraft(originalContent, null);
    await requestCloseSessionWorkspacePreview(state, retained.id);
    await Promise.all([revalidation, openSessionWorkspaceFile(state, { path: aliasPath })]);
    expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
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
    const response = {
      ...textResponse(state, "README.md", "File contents", { workspacePath: "README.md" }),
      root: "/workspace",
    };
    void openSessionWorkspaceFile(state, { path: "README.md", line: 2 });
    void openSessionWorkspaceFile(state, { path: "/workspace/README.md", line: 7 });
    const aliasUpdated = nextWorkspaceUpdate(state);
    pending.get("/workspace/README.md")!(response);
    await aliasUpdated;
    expect(getSessionWorkspace(state).previews[1]?.content.kind).toBe("file");
    const retained = getSessionWorkspace(state).previews[1]!;
    openSessionWorkspacePreview(state, "attachment:other", "other.txt", {
      kind: "markdown",
      content: "Other",
    });
    const olderUpdated = nextWorkspaceUpdate(state);
    pending.get("README.md")!(response);
    await olderUpdated;
    expect(getSessionWorkspace(state).previews).toHaveLength(2);
    expect(getSessionWorkspace(state).previews[0]).toBe(retained);
    expect(getSessionWorkspace(state).activePreviewId).toBe("attachment:other");
    expect(retained.content).toMatchObject({ navigation: { line: 7 } });
    void openSessionWorkspaceFile(state, { path: "README.md", line: 9 });
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
      void openSessionWorkspaceFile(state, { path: "asset.png" });
      await nextWorkspaceUpdate(state);
      expect(getSessionWorkspace(state).previews[0]?.content.kind).not.toBe("loading");
      const original = getSessionWorkspace(state).previews[0]!;
      void openSessionWorkspaceFile(state, { path: "/workspace/asset.png" });
      await nextWorkspaceUpdate(state);
      expect(getSessionWorkspace(state).previews).toEqual([original]);
      expect(getSessionWorkspace(state).activePreviewId).toBe(original.id);
      vi.mocked(state.sessions.getFile).mockResolvedValue({
        ...response,
        file: { ...response.file, content: "TkVX", size: 1024 },
      });
      void openSessionWorkspaceFile(state, { path: "asset.png" });
      await nextWorkspaceUpdate(state);
      expect(original.content).toMatchObject(
        previewKind === "image"
          ? { src: "data:image/png;base64,TkVX" }
          : { rawText: expect.stringContaining("1,024 bytes") },
      );
      expect(getSessionWorkspace(state).previews).toEqual([original]);
    },
  );

  it("scopes main-view tab and content IDs to each panel and keeps them stable", async () => {
    const panels = [mountPanel(), mountPanel()];
    await Promise.all(panels.map((panel) => panel.updateComplete));
    const tabs = panels.map((panel) => panel.querySelector<HTMLElement>(".tabstrip-tab")!);
    const ids = tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(2);
    for (const [index, panel] of panels.entries()) {
      const tab = tabs[index]!;
      const content = panel.querySelector(".chat-files-panel__content")!;
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBe(content);
      panel.previews = [...panel.previews];
      await panel.updateComplete;
      expect(panel.querySelector(".tabstrip-tab")?.id).toBe(ids[index]);
    }
  });

  it("does not recover sibling focus when the other pane loses its active tab", async () => {
    const panels = [mountPanel(), mountPanel()];
    await Promise.all(panels.map((panel) => panel.updateComplete));
    await Promise.resolve();
    const firstTab = panels[0]!.querySelector<HTMLElement>(".tabstrip-tab")!;
    const siblingTab = panels[1]!.querySelector<HTMLElement>(".tabstrip-tab")!;
    firstTab.focus();
    expect(document.activeElement).toBe(firstTab);
    panels[1]!.previews = [...panels[1]!.previews];
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
    void openSessionWorkspaceFile(state, { path: "pending.ts", line: 2 });
    void openSessionWorkspaceFile(state, { path: "pending.ts", line: 7 });
    const updated = nextWorkspaceUpdate(state);
    resolve(textResponse(state, "pending.ts", "one\ntwo"));
    await updated;
    expect(getSessionWorkspace(state).previews[0]?.content).toMatchObject({
      kind: "file",
      line: 7,
    });
    expect(state.sessions.getFile).toHaveBeenCalledOnce();
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
  });

  it("deduplicates stable identities, closes only the selected preview, and scopes tabs to reconnect", async () => {
    const state = host();
    const first = openSessionWorkspacePreview(state, "file:a", "a.txt", {
      kind: "markdown",
      content: "A",
    });
    openSessionWorkspacePreview(state, "file:b", "b.txt", { kind: "markdown", content: "B" });
    expect(openSessionWorkspacePreview(state, "file:a", "a.txt", { kind: "loading" })).toBe(first);
    expect(getSessionWorkspace(state).previews).toHaveLength(2);
    await requestCloseSessionWorkspacePreview(state, "file:a");
    expect(getSessionWorkspace(state).activePreviewId).toBe("file:b");
    selectSessionWorkspacePreview(state, null);
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
    state.connectionEpoch++;
    expect(getSessionWorkspace(state).previews).toEqual([]);
  });

  it("replaces only the temporary preview in place and reuses pinned identities", () => {
    const state = host();
    const open = (id: string) =>
      openSessionWorkspacePreview(state, id, id, { kind: "markdown", content: id }, "preview");
    const first = open("first.md");
    const second = open("second.md");
    expect(getSessionWorkspace(state).previews).toEqual([second]);
    expect(getSessionWorkspace(state).previews).not.toContain(first);
    pinSessionWorkspacePreview(state, second.id);
    const third = open("third.md");
    selectSessionWorkspacePreview(state, third.id);
    expect(third.pinned).toBe(false);
    const fourth = open("fourth.md");
    expect(getSessionWorkspace(state).previews).toEqual([second, fourth]);
    expect(open("second.md")).toBe(second);
    expect(getSessionWorkspace(state).previews).toEqual([second, fourth]);
    expect(getSessionWorkspace(state).activePreviewId).toBe(second.id);
  });

  it("retains a dirty temporary editor when opening another preview", async () => {
    const state = host();
    state.sessions.getFile = vi.fn().mockResolvedValue(textResponse(state, "draft.md", "OLD"));
    await openSessionWorkspaceFile(state, { path: "draft.md" });
    const loaded = getSessionWorkspace(state).previews[0]!;
    const content = loaded.content;
    if (content.kind !== "file") {
      throw new Error("Expected loaded file");
    }
    await requestCloseSessionWorkspacePreview(state, loaded.id);
    const retained = openSessionWorkspacePreview(
      state,
      loaded.id,
      loaded.label,
      content,
      "preview",
    );
    setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
    onTestFinished(() => setFileDraft(content, null));
    const next = openSessionWorkspacePreview(
      state,
      "next.md",
      "next.md",
      { kind: "loading" },
      "preview",
    );
    expect(getSessionWorkspace(state).previews).toEqual([retained, next]);
    expect(retained.content).toBe(content);
    expect(retained.pinned).toBe(true);
    expect(readFileDraft(content)?.content).toBe("UNSAVED");
  });

  it("settles background file reads without selecting them and rejects closed requests", async () => {
    const state = host();
    let resolve!: (value: unknown) => void;
    state.sessions.getFile = vi.fn().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    void openSessionWorkspaceFile(state, { path: "a.txt" });
    openSessionWorkspacePreview(state, "attachment:b", "b.txt", {
      kind: "attachment",
      title: "b.txt",
      src: "/media/b.txt",
    });
    const backgroundUpdated = nextWorkspaceUpdate(state);
    resolve({ ...textResponse(state, "a.txt", "A"), root: "/workspace" });
    await backgroundUpdated;
    expect(getSessionWorkspace(state).previews[0]?.content.kind).toBe("file");
    expect(getSessionWorkspace(state).activePreviewId).toBe("attachment:b");
    void openSessionWorkspaceFile(state, { path: "c.txt" });
    await requestCloseSessionWorkspacePreview(state, "file:c.txt");
    const closedUpdated = nextWorkspaceUpdate(state);
    resolve(textResponse(state, "c.txt", "C"));
    await closedUpdated;
    expect(getSessionWorkspace(state).previews.map((entry) => entry.id)).toEqual([
      "file:a.txt",
      "attachment:b",
    ]);
  });

  it("shows a held preview and recovers an unavailable file without duplicating its tab", async () => {
    const state = host();
    const first = createDeferred<SessionWorkspaceGetResult>();
    const retry = createDeferred<SessionWorkspaceGetResult>();
    const getFile = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    state.sessions.getFile = getFile;
    const panel = document.createElement("openclaw-chat-files-panel");
    const sync = () => {
      const workspace = getSessionWorkspace(state);
      panel.previews = workspace.previews;
      panel.activeId = workspace.activePreviewId;
    };
    panel.renderDetail = () =>
      Object.assign(document.createElement("div"), { textContent: "Ready" });
    const stop = sessionWorkspaceForHost(state).subscribe(sync);
    onTestFinished(stop);
    void openSessionWorkspaceFile(state, { path: "retry.txt" });
    sync();
    document.body.append(panel);
    await waitForSolid(() =>
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull(),
    );
    const preview = getSessionWorkspace(state).previews[0]!;
    first.reject(new Error("temporary failure"));
    await waitForSolid(() => expect(panel.textContent).toContain("temporary failure"));
    expect(preview.content.kind).toBe("unavailable");
    void openSessionWorkspaceFile(state, { path: "retry.txt" });
    retry.resolve(textResponse(state, "retry.txt", "Ready"));
    await waitForSolid(() => expect(panel.textContent).toContain("Ready"));
    expect(panel.textContent).not.toContain("temporary failure");
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("projects the shared hosted-tab contract and keeps inactive preview elements mounted", async () => {
    const warning = vi.spyOn(console, "warn");
    onTestFinished(() => {
      warning.mockRestore();
    });
    const state = host();
    const a = openSessionWorkspacePreview(
      state,
      "a",
      "a.md",
      { kind: "markdown", content: "A" },
      "preview",
    );
    const b = openSessionWorkspacePreview(state, "b", "b.txt", { kind: "markdown", content: "B" });
    const Draft = () => Object.assign(document.createElement("textarea"), { textContent: "draft" });
    const panel = document.createElement("openclaw-chat-files-panel");
    Object.assign(panel, {
      previews: getSessionWorkspace(state).previews,
      activeId: "a",
      renderDetail: Draft,
      onSelect: (id: string | null) => selectSessionWorkspacePreview(state, id),
      onClose: (id: string) => requestCloseSessionWorkspacePreview(state, id),
    });
    document.body.append(panel);
    await panel.updateComplete;
    await waitForSolid(() => expect(panel.querySelector("textarea")).not.toBeNull());
    const textarea = panel.querySelector("textarea")!;
    textarea.value = "unsaved";
    pinSessionWorkspacePreview(state, a.id);
    panel.previews = getSessionWorkspace(state).previews;
    await panel.updateComplete;
    expect(panel.querySelector("textarea")).toBe(textarea);
    expect(a.pinned).toBe(true);
    const hosted = readPanelHostedTabs(panel)!;
    expect(hosted.hostedTabs.map((tab) => tab.label)).toEqual(["a.md", "b.txt"]);
    hosted.selectHostedTab("b");
    panel.activeId = "b";
    await panel.updateComplete;
    expect(panel.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("unsaved");
    expect(panel.querySelector(".tabstrip")).toBeNull();
    panel.tabsInHeader = false;
    await panel.updateComplete;
    expect(panel.querySelectorAll(".tabstrip")).toHaveLength(1);
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(2);
    panel.tabsInHeader = true;
    await panel.updateComplete;
    expect(panel.querySelector(".tabstrip")).toBeNull();
    expect(panel.querySelector("textarea")).toBe(textarea);
    panel.previews = [
      { ...b, label: "renamed-b.txt" },
      { ...a, label: "renamed-a.md" },
    ];
    await panel.updateComplete;
    expect(readPanelHostedTabs(panel)?.hostedTabs.map((tab) => tab.label)).toEqual([
      "renamed-b.txt",
      "renamed-a.md",
    ]);
    expect([...panel.querySelectorAll("textarea")]).toContain(textarea);
    expect(textarea.value).toBe("unsaved");
    await hosted.closeHostedTab("a");
    expect(getSessionWorkspace(state).previews).not.toContain(a);
    panel.previews = getSessionWorkspace(state).previews;
    await panel.updateComplete;
    expect(textarea.isConnected).toBe(false);
    panel.remove();
    flush();
    expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
  });

  it.each(["close", "reopen", "disconnect"])(
    "handles %s while an App close is awaiting teardown",
    async (outcome) => {
      const pending = createDeferred();
      const panel = document.createElement("openclaw-chat-files-panel");
      const app = document.createElement("mcp-app-view");
      const connectedAtTeardown: boolean[] = [];
      const teardown = vi.fn(() => {
        connectedAtTeardown.push(app.isConnected);
        return pending.promise;
      });
      const headersAtRestart: boolean[] = [];
      const restart = vi.fn(() =>
        headersAtRestart.push(panel.querySelector(".rail-header") !== null),
      );
      Object.assign(app, { teardown, restartAfterTeardown: restart });
      onTestFinished(registerMcpAppUnmountTarget(app));
      const editor = document.createElement("textarea");
      const previews: SessionWorkspacePreview[] = [
        {
          id: "app",
          label: "Parts tray",
          content: {
            kind: "mcp-app",
            observeRetirement: () => () => {},
            title: "Parts tray",
            launch: {
              owner: createGatewayBrowserClientFixture(),
              sessionKey: "agent:main:files",
              serverName: "parts",
              entrypoint: {
                title: "Parts tray",
                toolName: "tray",
                resourceUri: "ui://parts/tray",
                entrypoint: { type: "thread" },
              },
            },
          },
        },
        { id: "file", label: "notes.md", content: { kind: "markdown", content: "Notes" } },
      ];
      panel.previews = previews;
      panel.activeId = "app";
      panel.renderDetail = ({ content }) => (content.kind === "mcp-app" ? app : editor);
      panel.onClose = (id) => {
        panel.previews = panel.previews.filter((preview) => preview.id !== id);
        panel.activeId = "file";
      };
      document.body.append(panel);
      await panel.updateComplete;
      flush();
      editor.value = "Unsaved draft";

      await panel.closeHostedTab("app");
      flush();
      expect(connectedAtTeardown).toEqual([true]);
      expect(panel.querySelector("mcp-app-view")).toBe(app);
      expect(app.isConnected).toBe(true);
      expect(restart).not.toHaveBeenCalled();

      panel.tabsInHeader = false;
      if (outcome === "reopen") {
        panel.previews = previews;
        panel.activeId = "app";
      } else if (outcome === "disconnect") {
        panel.remove();
      }
      await panel.updateComplete;
      flush();
      pending.resolve();
      await pending.promise;
      await waitForSolid(() => {
        if (outcome === "reopen") {
          expect(restart).toHaveBeenCalledOnce();
          expect(headersAtRestart).toEqual([true]);
          expect(panel.querySelector("mcp-app-view")).toBe(app);
        } else {
          expect(app.isConnected).toBe(false);
          expect(restart).not.toHaveBeenCalled();
        }
      });
      expect(teardown).toHaveBeenCalledOnce();
      if (outcome !== "disconnect") {
        expect(panel.querySelector("textarea")).toBe(editor);
        expect(editor.value).toBe("Unsaved draft");
      }
    },
  );

  it("opens the file browser from its action hosted outside the panel", async () => {
    const panel = mountPanel();
    panel.tabsInHeader = true;
    panel.workspace = {
      ...createSessionWorkspaceProps(host(), { presentation: "desktop" }),
      list: {
        sessionKey: "agent:main:files",
        root: "/workspace",
        files: [{ path: "reports", name: "reports", kind: "read", missing: false }],
      },
    };
    const onSelect = vi.fn((id: string | null) => {
      panel.activeId = id;
    });
    panel.onSelect = onSelect;
    await panel.updateComplete;
    const header = document.createElement("header");
    document.body.append(header);
    header.append(panel.hostedActions);

    panel.hostedActions.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
    await panel.updateComplete;
    const browser = panel.querySelector<HTMLElement>(".chat-files-panel__page");
    expect(browser?.hidden).toBe(false);
    expect(browser?.textContent).toContain("reports");
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

    panel.workspace = {
      ...createSessionWorkspaceProps(host(), { presentation: "desktop" }),
      browserSearch: "Refreshed",
    };
    panel.renderDetail = () =>
      Object.assign(document.createElement("div"), { textContent: "File contents" });
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
    panel.previews = [...panel.previews];
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledTimes(2);

    file.path = "docs/notes.md";
    panel.previews = [...panel.previews];
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
