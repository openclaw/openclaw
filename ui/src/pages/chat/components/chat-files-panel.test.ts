import { createEffect } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import { registerMcpAppUnmountTarget } from "../../../components/mcp-app-unmount.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  readPanelHostedTabs,
} from "../../../components/panel-hosted-tabs.ts";
import { installResizeObserverStub } from "../../../test-helpers/resize-observer.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../lib/toast-host.tsx";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import { createSessionWorkspaceHost } from "./chat-session-workspace-host.test-support.ts";
import {
  clearSessionWorkspacePreviews,
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

function fileFixture(path: string, content = "OLD", canonical = false) {
  const state = createSessionWorkspaceHost();
  const response = textResponse(state, path, content, canonical ? { workspacePath: path } : {});
  if (canonical) {
    response.root = "/workspace";
  }
  const getFile = vi.fn().mockResolvedValue(response);
  state.sessions.getFile = getFile;
  return { state, response, getFile, workspace: getSessionWorkspace(state) };
}

function filePreview(state: SessionWorkspaceHost) {
  const preview = getSessionWorkspace(state).previews[0]!;
  if (preview.content.kind !== "file") {
    throw new Error("Expected file preview");
  }
  return { preview, content: preview.content };
}

function openPreview(state: SessionWorkspaceHost, id: string, temporary = false) {
  return openSessionWorkspacePreview(
    state,
    id,
    id,
    { kind: "markdown", content: id },
    temporary ? "preview" : undefined,
  );
}

async function updatePanel(
  panel: ReturnType<typeof mountPanel>,
  props: Partial<ReturnType<typeof mountPanel>>,
) {
  Object.assign(panel, props);
  await panel.updateComplete;
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

async function readFile(state: SessionWorkspaceHost, path: string, line?: number) {
  void openSessionWorkspaceFile(state, { path, ...(line === undefined ? {} : { line }) });
  await nextWorkspaceUpdate(state);
}

function mountWorkspacePanel(state: SessionWorkspaceHost) {
  const panel = document.createElement("openclaw-chat-files-panel");
  const sync = () => {
    const workspace = getSessionWorkspace(state);
    panel.previews = workspace.previews;
    panel.activeId = workspace.activePreviewId;
  };
  onTestFinished(sessionWorkspaceForHost(state).subscribe(sync));
  sync();
  return panel;
}

beforeEach(installResizeObserverStub);
afterEach(() => document.body.replaceChildren());
describe("workspace file tabs", () => {
  it("opens a file while the catalog refresh is pending", async () => {
    const { state, workspace } = fileFixture("inventory.csv", "notebooks");
    workspace.list = {
      sessionKey: state.sessionKey,
      root: "/workspace",
      files: [],
      browser: { path: "", entries: [{ name: "reports", path: "reports", kind: "directory" }] },
    };
    const pending = createDeferred<NonNullable<typeof workspace.list>>();
    state.sessions.listFiles = vi.fn().mockReturnValue(pending.promise);
    const panel = mountWorkspacePanel(state);
    panel.tabsInHeader = false;
    panel.presentation = "desktop";
    panel.renderDetail = ({ content }) =>
      content.kind === "file" ? content.content : content.kind;
    const sync = () => {
      panel.workspace = createSessionWorkspaceProps(state, { presentation: "desktop" });
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
    await waitForSolid(() =>
      expect(
        panel.querySelector(".chat-files-panel__page:not(.chat-files-panel__catalog):not([hidden])")
          ?.textContent,
      ).toContain("notebooks"),
    );
    expect(panel.querySelector('button[aria-label="reports"]')).not.toBeNull();
  });

  it("preserves a draft created during a read", async () => {
    const { state, response: initial, getFile } = fileFixture("draft.md");
    initial.file.hash = "old";
    const read = createDeferred<SessionWorkspaceGetResult>();
    getFile.mockResolvedValueOnce(initial).mockReturnValue(read.promise);
    await readFile(state, "draft.md");
    const { preview, content } = filePreview(state);
    try {
      void openSessionWorkspaceFile(state, { path: "draft.md" });
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
      setFileDraft(content, { content: "UNSAVED", expectedHash: "old" });
      const updated = nextWorkspaceUpdate(state);
      read.resolve({ ...initial, file: { ...initial.file, content: "NEW", hash: "new" } });
      await updated;
      expect(preview.content).toBe(content);
      expect(readFileDraft(content)?.content).toBe("UNSAVED");
    } finally {
      setFileDraft(content, null);
    }
  });

  it.each(["session", "connection", "closed"])(
    "ignores a revalidation after its %s changes",
    async (change) => {
      const { state, response: initial, getFile } = fileFixture("stale.md");
      const read = createDeferred<SessionWorkspaceGetResult>();
      getFile.mockResolvedValueOnce(initial).mockReturnValue(read.promise);
      await readFile(state, "stale.md");
      const { preview, content } = filePreview(state);
      void openSessionWorkspaceFile(state, { path: "stale.md" });
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
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
    ["./notes.md", "newer first", false, false],
    ["notes.md", "older first", true, false],
    ["notes.md", "newer first", true, false],
    ["notes.md", "older first", true, true],
  ] as const)(
    "keeps latest alias intent after %s with %s (failed=%s, unrelated=%s)",
    async (olderPath, order, failed, unrelatedError) => {
      const { state, response, getFile, workspace } = fileFixture("notes.md", "CURRENT", true);
      const pending = new Map<
        string,
        { resolve: (value: typeof response) => void; reject: (error: Error) => void }
      >();
      getFile.mockResolvedValueOnce(response).mockImplementation(
        (_key, path: string) =>
          new Promise((resolve, reject) => {
            pending.set(path, { resolve, reject });
          }),
      );
      await readFile(state, "notes.md");
      const { preview: retained } = filePreview(state);
      void openSessionWorkspaceFile(state, { path: olderPath });
      void openSessionWorkspaceFile(state, { path: "/workspace/notes.md" });
      await vi.waitFor(() => expect(pending.size).toBe(2));
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
        loadSessionWorkspace(state, workspace, true);
        await nextWorkspaceUpdate(state);
        expect(workspace.error).toBe("List failed");
      }
      const secondUpdated = nextWorkspaceUpdate(state);
      if (order === "older first") {
        newer();
      } else {
        older();
      }
      await secondUpdated;
      expect(workspace.previews).toEqual([retained]);
      expect(retained.content).toMatchObject({ content: "CURRENT" });
      expect(workspace.error).toBe(unrelatedError ? "List failed" : null);
    },
  );

  it("renders newer alias content before an older canonical read settles", async () => {
    const { state, response: initial, getFile } = fileFixture("notes.md", "INITIAL", true);
    const older = createDeferred<SessionWorkspaceGetResult>();
    const newer = createDeferred<SessionWorkspaceGetResult>();
    getFile
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const panel = mountWorkspacePanel(state);
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
    onTestFinished(() => older.resolve(initial));
    document.body.append(panel);
    void openSessionWorkspaceFile(state, { path: "notes.md" });
    await waitForSolid(() => expect(panel.textContent).toContain("INITIAL"));
    const preview = getSessionWorkspace(state).previews[0]!;
    void openSessionWorkspaceFile(state, { path: "notes.md" });
    void openSessionWorkspaceFile(state, { path: "/workspace/notes.md" });
    newer.resolve({ ...initial, file: { ...initial.file, content: "CURRENT" } });
    await waitForSolid(() => expect(panel.textContent).toContain("CURRENT"));
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
  });

  it.each([
    ["README.md", "/workspace/README.md", false],
    ["/workspace/README.md", "README.md", true],
  ] as const)("reconciles %s and %s with dirty=%s", async (firstPath, aliasPath, dirty) => {
    const { state, response, getFile, workspace } = fileFixture(
      "README.md",
      "Original buffer",
      true,
    );
    await readFile(state, firstPath, 2);
    const { preview: retained, content: originalContent } = filePreview(state);
    if (dirty) {
      setFileDraft(originalContent, { content: "Unsaved buffer", expectedHash: "original" });
      onTestFinished(() => setFileDraft(originalContent, null));
    }
    getFile.mockResolvedValue({
      ...response,
      file: { ...response.file, content: "New disk buffer" },
    });
    await readFile(state, aliasPath, 7);
    expect(workspace.previews).toEqual([retained]);
    expect(retained.content).toMatchObject({
      content: dirty ? "Original buffer" : "New disk buffer",
      navigation: { line: 7 },
    });
    if (dirty) {
      expect(retained.content).toBe(originalContent);
      expect(readFileDraft(originalContent)?.content).toBe("Unsaved buffer");
    }
    expect(workspace.activePreviewId).toBe(retained.id);
    const revalidation = openSessionWorkspaceFile(state, { path: aliasPath, line: 9 });
    expect(retained.content).toMatchObject({ navigation: { line: 9 } });
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(dirty ? 2 : 3));
    setFileDraft(originalContent, null);
    await revalidation;
  });

  it("merges late aliases without stealing selection or replacing newer line intent", async () => {
    const { state, response, workspace, getFile } = fileFixture("README.md", "File contents", true);
    const pending = new Map<string, (value: SessionWorkspaceGetResult) => void>();
    getFile.mockImplementation(
      (_key: string, path: string) =>
        new Promise<SessionWorkspaceGetResult>((resolve) => {
          pending.set(path, resolve);
        }),
    );
    void openSessionWorkspaceFile(state, { path: "README.md", line: 2 });
    void openSessionWorkspaceFile(state, { path: "/workspace/README.md", line: 7 });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    const aliasUpdated = nextWorkspaceUpdate(state);
    pending.get("/workspace/README.md")!(response);
    await aliasUpdated;
    const retained = workspace.previews[1]!;
    openPreview(state, "attachment:other");
    const olderUpdated = nextWorkspaceUpdate(state);
    pending.get("README.md")!(response);
    await olderUpdated;
    expect(workspace.previews).toHaveLength(2);
    expect(workspace.previews[0]).toBe(retained);
    expect(workspace.activePreviewId).toBe("attachment:other");
    expect(retained.content).toMatchObject({ navigation: { line: 7 } });
    void openSessionWorkspaceFile(state, { path: "README.md", line: 9 });
    expect(workspace.activePreviewId).toBe(retained.id);
    expect(retained.content).toMatchObject({ navigation: { line: 9 } });
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(3));
  });

  it.each(["managed", "unmanaged", "repository", "denied"] as const)(
    "validates a document link before reusing a dirty target (%s)",
    async (scope) => {
      const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
      const { state, response, getFile, workspace } = fileFixture(
        "reports/evidence.md",
        "Disk evidence",
        true,
      );
      const repository = scope === "repository";
      if (repository) {
        response.root = undefined;
        response.sessionKey = "agent:main:repository-source";
      }
      const requestPath = (path: string) => (repository ? path : `/workspace/${path}`);
      response.source =
        scope === "unmanaged"
          ? undefined
          : {
              workspaceId: "report-workspace",
              root: response.root ?? null,
              fileRoot: repository ? null : "/workspace/nested-cwd",
            };
      await openSessionWorkspaceFile(state, {
        path: requestPath("reports/evidence.md"),
        sessionKey: response.sessionKey,
      });
      const { preview: retained, content: original } = filePreview(state);
      setFileDraft(original, { content: "Unsaved evidence", expectedHash: "original" });
      onTestFinished(() => setFileDraft(original, null));
      getFile.mockResolvedValue({
        ...response,
        file: {
          ...response.file,
          name: "report.md",
          path: "reports/report.md",
          workspacePath: "reports/report.md",
          content: "# Report",
        },
      });
      const sourcePreview = await openSessionWorkspaceFile(state, {
        path: requestPath("reports/report.md"),
        sessionKey: response.sessionKey,
      });
      if (!sourcePreview || sourcePreview.content.kind !== "file") {
        throw new Error("Report did not open");
      }
      const source = sourcePreview.content;
      const held = createDeferred<SessionWorkspaceGetResult>();
      getFile.mockImplementationOnce(() => held.promise);
      const opening = openSessionWorkspaceFile(
        state,
        { path: "evidence.md", relativeTo: source },
        "preview",
      );
      await vi.waitFor(() =>
        expect(getFile).toHaveBeenLastCalledWith(
          response.sessionKey,
          repository ? "./reports/evidence.md" : "/workspace/reports/evidence.md",
          { agentId: "main" },
        ),
      );
      expect(workspace.activePreviewId).toBe(sourcePreview.id);
      held.resolve(response);
      await opening;
      expect(workspace.activePreviewId).toBe(retained.id);
      expect(retained.content).toBe(original);
      expect(readFileDraft(original)?.content).toBe("Unsaved evidence");

      selectSessionWorkspacePreview(state, sourcePreview.id);
      if (scope === "denied") {
        getFile.mockRejectedValueOnce(new Error("Access denied"));
      } else {
        getFile.mockResolvedValueOnce(
          scope === "unmanaged"
            ? { ...response, root: "/replacement" }
            : {
                ...response,
                source: { ...response.source!, workspaceId: "replacement-workspace" },
              },
        );
      }
      await openSessionWorkspaceFile(state, { path: "evidence.md", relativeTo: source }, "preview");
      expect(workspace.activePreviewId).toBe(sourcePreview.id);
      expect(workspace.error).toContain(scope === "denied" ? "Access denied" : "workspace changed");
      await vi.dynamicImportSettled();
      await waitForSolid(() => expect(toast.textContent).toContain(workspace.error));
      expect(retained.content).toBe(original);
      expect(readFileDraft(original)?.content).toBe("Unsaved evidence");
    },
  );

  it.each([
    { path: "reports/report.md", link: "../../../outside.md", request: "./../../outside.md" },
    { path: "report.md", link: "missing.md", request: "./missing.md" },
  ])(
    "keeps rootless document target $link explicit and native-authorized",
    async ({ path, link, request }) => {
      const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
      const { state, response, getFile, workspace } = fileFixture(path, "# Report", true);
      response.root = undefined;
      const preview = await openSessionWorkspaceFile(state, { path });
      if (!preview || preview.content.kind !== "file") {
        throw new Error("Report did not open");
      }
      state.sessions.listFiles = vi.fn();
      getFile.mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session file not found",
          details: { type: "session_file_not_found" },
        }),
      );
      await openSessionWorkspaceFile(state, { path: link, relativeTo: preview.content }, "preview");
      expect(getFile).toHaveBeenLastCalledWith(state.sessionKey, request, { agentId: "main" });
      expect(state.sessions.listFiles).not.toHaveBeenCalled();
      expect(workspace.activePreviewId).toBe(preview.id);
      expect(workspace.previews).toEqual([preview]);
      await vi.dynamicImportSettled();
      await waitForSolid(() => expect(toast.textContent).toContain("session file not found"));
    },
  );

  it("reconciles canonical aliases for non-text previews", async () => {
    const { state, response, getFile, workspace } = fileFixture("asset.png", "iVBORw0KGgo=", true);
    Object.assign(response.file, {
      previewKind: "image",
      mimeType: "image/png",
      contentEncoding: "base64",
    });
    await readFile(state, "asset.png");
    const original = workspace.previews[0]!;
    await readFile(state, "/workspace/asset.png");
    expect(workspace.activePreviewId).toBe(original.id);
    getFile.mockResolvedValue({
      ...response,
      file: { ...response.file, content: "TkVX" },
    });
    await readFile(state, "asset.png");
    expect(original.content).toMatchObject({ src: "data:image/png;base64,TkVX" });
    expect(workspace.previews).toEqual([original]);
  });

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
    const state = createSessionWorkspaceHost();
    const read = createDeferred<SessionWorkspaceGetResult>();
    state.sessions.getFile = vi.fn().mockReturnValue(read.promise);
    void openSessionWorkspaceFile(state, { path: "pending.ts", line: 2 });
    void openSessionWorkspaceFile(state, { path: "pending.ts", line: 7 });
    const updated = nextWorkspaceUpdate(state);
    read.resolve(textResponse(state, "pending.ts", "one\ntwo"));
    await updated;
    expect(getSessionWorkspace(state).previews[0]?.content).toMatchObject({
      kind: "file",
      line: 7,
    });
    expect(state.sessions.getFile).toHaveBeenCalledOnce();
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
  });

  it.each(["preview", undefined] as const)(
    "opens the first file with its tree collapsed and preserves an explicit toggle (%s)",
    async (disposition) => {
      const state = createSessionWorkspaceHost();
      state.sessions.getFile = vi
        .fn()
        .mockImplementation(async (_sessionKey, path) =>
          textResponse(state, path, "File contents"),
        );
      const treeVisible = () => createSessionWorkspaceProps(state).navigation.treeVisible;
      const select = (id: string | null, visible: boolean) => {
        selectSessionWorkspacePreview(state, id);
        expect(treeVisible()).toBe(visible);
      };
      const open = async (path: string, visible: boolean) => {
        await openSessionWorkspaceFile(state, { path }, disposition);
        expect(treeVisible()).toBe(visible);
      };
      expect(treeVisible()).toBe(true);
      await open("first.txt", false);
      select(null, true);
      select("file:first.txt", false);
      createSessionWorkspaceProps(state).onTreeVisibleChange(true);
      await open("second.txt", true);
      selectSessionWorkspacePreview(state, null);
      select("file:second.txt", true);
      createSessionWorkspaceProps(state).onTreeVisibleChange(false);
      await open("third.txt", false);
      select(null, true);
      await open("fourth.txt", false);
    },
  );

  it("restores catalog navigation on retirement without reading until Files is presented", async () => {
    const state = createSessionWorkspaceHost({
      agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    });
    const workspace = getSessionWorkspace(state);
    const listing = {
      sessionKey: state.sessionKey,
      files: [],
      browser: { path: "other", entries: [] },
    };
    const listFiles = vi.fn().mockResolvedValue(listing);
    state.sessions.listFiles = listFiles;
    workspace.browserPath = "catalog";
    workspace.browserSearch = "needle";
    workspace.filter = "read";
    Object.assign(workspace.tree!, {
      expandedPaths: ["", "catalog"],
      searchOpen: true,
      treeScroll: 40,
    });
    openPreview(state, "file:preview.md");
    createSessionWorkspaceProps(state).onBrowsePath("other");
    await workspace.readResult;
    listFiles.mockClear();

    clearSessionWorkspacePreviews(state);
    const hidden = createSessionWorkspaceProps(state, { presented: false, expanded: true });
    expect(hidden.navigation).toMatchObject({
      browserPath: "catalog",
      browserSearch: "needle",
      filter: "read",
      expandedPaths: ["", "catalog"],
      searchOpen: true,
      treeVisible: true,
      treeScroll: 40,
    });
    expect(workspace.previews).toEqual([]);
    expect(hidden.activeId).toBeNull();
    expect(listFiles).not.toHaveBeenCalled();
    createSessionWorkspaceProps(state, { presented: true, expanded: false });
    expect(listFiles).not.toHaveBeenCalled();
    createSessionWorkspaceProps(state, { presented: true, expanded: true });
    await workspace.readResult;
    expect(listFiles).toHaveBeenCalledWith(state.sessionKey, {
      path: "",
      search: "needle",
      agentId: "main",
    });

    // With no selected preview, the current catalog is newer than the saved snapshot.
    createSessionWorkspaceProps(state).onBrowsePath("newer");
    await workspace.readResult;
    createSessionWorkspaceProps(state).onSetFilter("changed");
    listFiles.mockClear();
    clearSessionWorkspacePreviews(state);
    expect(createSessionWorkspaceProps(state).navigation).toMatchObject({
      browserPath: "newer",
      browserSearch: "",
      filter: "changed",
      treeVisible: true,
    });
    expect(listFiles).not.toHaveBeenCalled();

    openSessionWorkspacePreview(state, "app", "Workspace app", {
      kind: "mcp-app",
      title: "Workspace app",
      observeRetirement: () => () => {},
      launch: {
        owner: state.client!,
        sessionKey: state.sessionKey,
        serverName: "workspace",
        entrypoint: {
          title: "Workspace app",
          toolName: "browse",
          resourceUri: "ui://workspace/browse",
          entrypoint: { type: "thread" },
        },
      },
    });
    clearSessionWorkspacePreviews(state);
    expect(createSessionWorkspaceProps(state).navigation).toMatchObject({
      browserPath: "newer",
      browserSearch: "",
      filter: "changed",
      treeVisible: true,
    });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("closes only the selected preview and scopes tabs to reconnect", async () => {
    const state = createSessionWorkspaceHost();
    openPreview(state, "file:a");
    openPreview(state, "file:b");
    await requestCloseSessionWorkspacePreview(state, "file:a");
    expect(getSessionWorkspace(state).activePreviewId).toBe("file:b");
    selectSessionWorkspacePreview(state, null);
    expect(getSessionWorkspace(state).previews).toHaveLength(1);
    state.connectionEpoch++;
    expect(getSessionWorkspace(state).previews).toEqual([]);
  });

  it("replaces only the temporary preview in place and reuses pinned identities", () => {
    const state = createSessionWorkspaceHost();
    const open = (id: string) => openPreview(state, id, true);
    open("first.md");
    const second = open("second.md");
    expect(getSessionWorkspace(state).previews).toEqual([second]);
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
    const { state } = fileFixture("draft.md");
    await openSessionWorkspaceFile(state, { path: "draft.md" });
    const { preview: loaded, content } = filePreview(state);
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
    const next = openPreview(state, "next.md", true);
    expect(getSessionWorkspace(state).previews).toEqual([retained, next]);
    expect(retained.content).toBe(content);
    expect(retained.pinned).toBe(true);
    expect(readFileDraft(content)?.content).toBe("UNSAVED");
  });

  it("shows a held preview and recovers an unavailable file without duplicating its tab", async () => {
    const state = createSessionWorkspaceHost();
    const first = createDeferred<SessionWorkspaceGetResult>();
    const retry = createDeferred<SessionWorkspaceGetResult>();
    const getFile = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    state.sessions.getFile = getFile;
    const panel = mountWorkspacePanel(state);
    panel.presentation = "desktop";
    panel.renderDetail = () =>
      Object.assign(document.createElement("div"), { textContent: "Ready" });
    void openSessionWorkspaceFile(state, { path: "retry.txt" });
    document.body.append(panel);
    await waitForSolid(() =>
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull(),
    );
    const preview = getSessionWorkspace(state).previews[0]!;
    first.reject(new Error("temporary failure"));
    await waitForSolid(() => expect(panel.textContent).toContain("temporary failure"));
    const paths = [...panel.querySelectorAll<HTMLElement>(".sidebar-file-view__path")];
    expect(paths).toHaveLength(2);
    panel.previews = [{ ...preview, label: "renamed.txt" }];
    await panel.updateComplete;
    expect([...panel.querySelectorAll(".sidebar-file-view__path")]).toEqual(paths);
    expect(paths.map((path) => [path.textContent, path.title])).toEqual([
      ["renamed.txt", "renamed.txt"],
      ["renamed.txt", "renamed.txt"],
    ]);
    void openSessionWorkspaceFile(state, { path: "retry.txt" });
    retry.resolve(textResponse(state, "retry.txt", "Ready"));
    await waitForSolid(() => expect(panel.textContent).toContain("Ready"));
    expect(panel.textContent).not.toContain("temporary failure");
    expect(getSessionWorkspace(state).previews).toEqual([preview]);
  });

  it("projects the shared hosted-tab contract and keeps inactive preview elements mounted", async () => {
    const warning = vi.spyOn(console, "warn");
    onTestFinished(() => warning.mockRestore());
    const state = createSessionWorkspaceHost();
    const a = openPreview(state, "a.md", true);
    const b = openPreview(state, "b.txt");
    const Draft = () => Object.assign(document.createElement("textarea"), { textContent: "draft" });
    const panel = document.createElement("openclaw-chat-files-panel");
    Object.assign(panel, {
      previews: getSessionWorkspace(state).previews,
      activeId: a.id,
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
    await updatePanel(panel, { previews: getSessionWorkspace(state).previews });
    expect(panel.querySelector("textarea")).toBe(textarea);
    const hosted = readPanelHostedTabs(panel)!;
    expect(hosted.hostedTabs.map((tab) => tab.label)).toEqual(["a.md", "b.txt"]);
    hosted.selectHostedTab(b.id);
    await updatePanel(panel, { activeId: b.id });
    expect(panel.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("unsaved");
    expect(panel.querySelector(".tabstrip")).toBeNull();
    await updatePanel(panel, { tabsInHeader: false });
    expect(panel.querySelectorAll(".tabstrip")).toHaveLength(1);
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(2);
    await updatePanel(panel, { tabsInHeader: true });
    expect(panel.querySelector(".tabstrip")).toBeNull();
    expect(panel.querySelector("textarea")).toBe(textarea);
    await updatePanel(panel, {
      previews: [
        { ...b, label: "renamed-b.txt" },
        { ...a, label: "renamed-a.md" },
      ],
    });
    expect(readPanelHostedTabs(panel)?.hostedTabs.map((tab) => tab.label)).toEqual([
      "renamed-b.txt",
      "renamed-a.md",
    ]);
    expect([...panel.querySelectorAll("textarea")]).toContain(textarea);
    expect(textarea.value).toBe("unsaved");
    await hosted.closeHostedTab(a.id);
    expect(getSessionWorkspace(state).previews).not.toContain(a);
    await updatePanel(panel, { previews: getSessionWorkspace(state).previews });
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
      ...createSessionWorkspaceProps(createSessionWorkspaceHost(), { presentation: "desktop" }),
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
      ...createSessionWorkspaceProps(createSessionWorkspaceHost(), { presentation: "desktop" }),
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
