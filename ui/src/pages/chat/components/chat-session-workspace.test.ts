import { createComponent, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../../../api/types.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import {
  getSessionWorkspace,
  loadSessionWorkspace,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import {
  loadedSidebarContent,
  createSidebarContentRecorder,
} from "./chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps as workspaceProps,
  openSessionWorkspaceFile,
  refreshSessionWorkspace,
  revealSessionWorkspaceFile,
  resolveSessionDiffSidebarContent,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar-content-types.ts";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

function workspaceFile(
  path: string,
  overrides: Partial<SessionWorkspaceGetResult["file"]> = {},
): SessionWorkspaceGetResult["file"] {
  return { path, name: path.split(/[\\/]/).at(-1)!, kind: "read", missing: false, ...overrides };
}

function textFile(
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

function imageFile(mimeType: string) {
  return workspaceFile("screenshots/result.png", {
    mimeType,
    contentEncoding: "base64",
    previewKind: "image",
    content: "iVBORw0KGgo=",
  });
}

function workspaceList(
  root: string,
  overrides: Partial<SessionWorkspaceListResult> = {},
): SessionWorkspaceListResult {
  return { sessionKey: "agent:main:current", root, files: [], ...overrides };
}

async function expectUnavailable(state: SessionWorkspaceHost, message: string) {
  await vi.waitFor(() => expect(workspaceProps(state).error).toBe(message));
  expect(state.handleOpenSidebar).toHaveBeenCalledOnce();
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toEqual({
    kind: "unavailable",
    message,
  });
}

function createHost<T extends object>(overrides: T) {
  return {
    connected: true,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    handleOpenSidebar: vi.fn(),
    hello: null,
    sessionKey: "agent:main:current",
    sidebarContent: null,
    ...overrides,
  };
}

function createLoadingHost(sessions: object, overrides: object = {}): SessionWorkspaceHost {
  return createHost({
    client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
    connectionEpoch: 1,
    sessions,
    ...overrides,
  }) as unknown as SessionWorkspaceHost;
}

function createFileHost(
  file: SessionWorkspaceGetResult["file"],
  hello = gatewayHelloForMethods([]),
): SessionWorkspaceHost {
  return createHost({
    client: {},
    handleOpenSidebar: createSidebarContentRecorder(),
    hello,
    sessions: {
      getFile: vi.fn().mockResolvedValue({ sessionKey: "agent:main:current", file }),
    },
  }) as unknown as SessionWorkspaceHost;
}

function readPreview(file: SessionWorkspaceGetResult["file"], hello = gatewayHelloForMethods([])) {
  const state = createFileHost(file, hello);
  void openSessionWorkspaceFile(state, { path: file.path });
  return loadedSidebarContent(state);
}

function nextWorkspaceUpdate(state: SessionWorkspaceHost, ready: () => boolean) {
  const next = createDeferred();
  const stop = sessionWorkspaceForHost(state).subscribe(() => {
    if (ready()) {
      next.resolve();
    }
  });
  return next.promise.finally(stop);
}

function mountWorkspaceRail(container: HTMLElement, state: SessionWorkspaceHost) {
  mountSolid(
    () => {
      const workspace = projectOwner(sessionWorkspaceForHost(state), (owner) => owner.state);
      return createComponent(SessionWorkspaceRail, {
        get workspace() {
          workspace.read();
          return workspaceProps(state, { expanded: true });
        },
      });
    },
    { container },
  );
  return flush;
}

describe("session workspace state", () => {
  it("keeps filter changes in the current session and resets them for a new session", () => {
    const state = createHost({
      client: null,
      connected: false,
      connectionEpoch: 1,
      sessions: {},
    }) as unknown as SessionWorkspaceHost;

    const workspace = workspaceProps(state);
    expect(workspace.filter).toBe("all");
    const owner = sessionWorkspaceForHost(state);
    const previous = owner.state;
    const published = vi.fn(() => expect(owner.state?.filter).toBe("read"));
    const stop = owner.subscribe(published);
    workspace.onSetFilter("read");
    expect(workspaceProps(state).filter).toBe("read");
    expect(owner.state).toBe(previous);
    expect(published).toHaveBeenCalledOnce();
    stop();
    workspace.onSetFilter("changed");
    expect(published).toHaveBeenCalledOnce();

    state.sessionKey = "agent:main:next";
    expect(workspaceProps(state).filter).toBe("all");
  });

  it("loads files and artifacts together while showing the Files skeleton until both settle", async () => {
    const list = createDeferred<SessionWorkspaceListResult>();
    const listFiles = vi.fn(() => list.promise);
    const artifacts = createDeferred<{ artifacts: [] }>();
    const request = vi.fn(() => artifacts.promise);
    const state = createLoadingHost(
      { listFiles },
      {
        client: { request },
        sessionKey: "agent:main:cloud",
      },
    );
    const mount = document.createElement("div");

    const updateRail = mountWorkspaceRail(mount, state);

    expect(listFiles).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledExactlyOnceWith("artifacts.list", {
      sessionKey: state.sessionKey,
      agentId: "main",
    });
    const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("files");
    expect(mount.textContent).not.toContain("Loading session workspace");

    list.resolve({
      sessionKey: state.sessionKey,
      root: "/workspace/cloud",
      files: [{ kind: "modified", name: "slow.ts", path: "src/slow.ts", missing: false }],
    });
    await Promise.resolve();
    expect(workspaceProps(state)).toMatchObject({ loading: true, list: null });
    artifacts.resolve({ artifacts: [] });
    await vi.waitFor(() => expect(workspaceProps(state).loading).toBe(false));
    updateRail();

    expect(mount.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(mount.querySelector('button[aria-label="src/slow.ts"]')).not.toBeNull();
  });

  it("rotates Files and Review ownership across a same-client reconnect", async () => {
    const replacementList = createDeferred<SessionWorkspaceListResult>();
    const oldFile = createDeferred<SessionWorkspaceGetResult>();
    const oldArtifacts = createDeferred<{ artifacts: [] }>();
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce(workspaceList("/checkout/a", { gitCheckout: true }))
      .mockResolvedValueOnce(workspaceList("/checkout/a-stale-refresh"))
      .mockReturnValueOnce(replacementList.promise);
    const getFile = vi.fn().mockReturnValue(oldFile.promise);
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ artifacts: [] })
        .mockReturnValueOnce(oldArtifacts.promise)
        .mockResolvedValue({ artifacts: [] }),
    };
    const state = createLoadingHost(
      { getFile, listFiles },
      {
        client,
        hello: gatewayHelloForMethods(["sessions.diff"]),
      },
    );
    const handleOpenSidebar = vi.fn((content: SidebarSelection | null) => {
      if (!content?.fileTab) {
        state.sidebarContent = content;
      }
    });
    state.handleOpenSidebar = handleOpenSidebar;

    workspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(workspaceProps(state).list?.root).toBe("/checkout/a"));
    const oldDiff = resolveSessionDiffSidebarContent(state);
    expect(oldDiff?.kind).toBe("session-diff");
    workspaceProps(state, { expanded: true }).onOpenDiff?.();
    expect(state.sidebarContent).toBe(oldDiff);
    void openSessionWorkspaceFile(state, { path: "README.md" });
    expect(handleOpenSidebar).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "loading" }),
    );
    loadSessionWorkspace(state, getSessionWorkspace(state), true);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));

    state.connectionEpoch = 2;
    const pending = workspaceProps(state, { expanded: true });

    expect(pending).toMatchObject({ list: null, onOpenDiff: expect.any(Function) });
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(state.sidebarContent).toBeNull();

    oldFile.resolve({
      sessionKey: "agent:main:current",
      root: "/checkout/a",
      file: textFile("README.md", "old checkout"),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.sidebarContent).toBeNull();

    replacementList.resolve(workspaceList("/checkout/b", { gitCheckout: true }));
    await vi.waitFor(() => expect(workspaceProps(state).list?.root).toBe("/checkout/b"));
    const replacementWorkspace = state.sessionWorkspaceState;
    const replacementContents = replacementWorkspace?.list;
    oldArtifacts.resolve({ artifacts: [] });
    await oldArtifacts.promise;
    await Promise.resolve();
    expect(state.sessionWorkspaceState).toBe(replacementWorkspace);
    expect(state.sessionWorkspaceState?.list).toBe(replacementContents);
    expect(resolveSessionDiffSidebarContent(state)).not.toBe(oldDiff);
  });

  it("refreshes the displayed diff while an older uncommitted poll is pending", async () => {
    const snapshot = (line: string): SessionsDiffResult => ({
      sessionKey: "agent:main:current",
      files: [
        {
          path: "example.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: `@@ -1 +1 @@\n-before\n+${line}`,
        },
      ],
      additions: 1,
      deletions: 1,
    });
    const original = snapshot("original snapshot");
    const pending = createDeferred<SessionsDiffResult>();
    let holdPoll = false;
    const state = createLoadingHost(
      {},
      {
        client: {
          request: (_method: string, params: { poll?: boolean }) =>
            params.poll
              ? holdPoll
                ? pending.promise
                : Promise.resolve(original)
              : Promise.resolve(snapshot("updated snapshot")),
        },
        hello: gatewayHelloForMethods(["sessions.diff"]),
      },
    );
    const content = resolveSessionDiffSidebarContent(state);
    if (content?.kind !== "session-diff") {
      throw new Error("Expected a diff owner");
    }
    const { container } = mountSolid(() =>
      createComponent(SessionDiffPanel, {
        mobile: true,
        owner: content.owner,
        scopeRequest: { owner: content.owner, scope: { scope: "uncommitted" } },
        loader: content.load,
        onResult: content.onResult,
        execNode: null,
        loadFileText: null,
        openFile: null,
        revealFile: null,
      }),
    );
    await waitForSolid(() => expect(container.textContent).toContain("original snapshot"));
    holdPoll = true;
    const polling = content.load({ scope: "uncommitted" });
    try {
      container.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
      await waitForSolid(() => expect(container.textContent).toContain("updated snapshot"));
    } finally {
      pending.resolve(original);
      await polling;
    }
    expect(content.uncommitted?.files[0]?.patch).toContain("updated snapshot");
  });

  it("retains uncommitted changes while computing and retires retries with visible demand", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const result = {
      sessionKey: "agent:main:current",
      files: [{ path: "changed.ts", status: "modified", additions: 2, deletions: 1 }],
      additions: 2,
      deletions: 1,
    };
    const computing = { ...result, files: [], additions: 0, deletions: 0, computing: true };
    const request = vi.fn().mockResolvedValueOnce(computing).mockResolvedValue(result);
    const state = createLoadingHost(
      {},
      {
        client: { request },
        hello: gatewayHelloForMethods(["sessions.diff"]),
      },
    );
    const content = resolveSessionDiffSidebarContent(state);
    if (content?.kind !== "session-diff") {
      throw new Error("Expected a diff owner");
    }
    const stop = content.requestUncommitted?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(content.uncommitted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(content.uncommitted).toBe(result);
    if (stop) {
      stop();
    }
    request.mockResolvedValue(computing);
    const stopRefresh = content.requestUncommitted?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(content.uncommitted).toBe(result);
    if (stopRefresh) {
      stopRefresh();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);

    content.requestUncommitted?.();
    await vi.advanceTimersByTimeAsync(0);
    state.connectionEpoch += 1;
    resolveSessionDiffSidebarContent(state);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(content.uncommitted).toBe(result);
  });

  it("retries a pending visible reload without publishing a retired load failure", async () => {
    const initialLoad = createDeferred();
    const listFiles = vi
      .fn()
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({ sessionKey: "agent:main:current", files: [] });
    const state = createLoadingHost({ listFiles });

    workspaceProps(state, { expanded: true });
    expect(listFiles).toHaveBeenCalledTimes(1);
    refreshSessionWorkspace(state, true);
    const retired = nextWorkspaceUpdate(state, () => !getSessionWorkspace(state).loading);
    initialLoad.reject(new Error("temporary failure"));
    await retired;
    expect(getSessionWorkspace(state).pendingReload).toBe(true);
    expect(getSessionWorkspace(state).error).toBeNull();

    const reloaded = nextWorkspaceUpdate(state, () => !getSessionWorkspace(state).loading);
    workspaceProps(state, { expanded: true });
    await reloaded;

    expect(workspaceProps(state).list).not.toBeNull();
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(workspaceProps(state).error).toBeNull();
  });

  it("retries the current query once when its search timer is pending", async () => {
    vi.useFakeTimers();
    try {
      const listFiles = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue({ sessionKey: "agent:main:current", files: [] });
      const state = createLoadingHost({ listFiles });
      workspaceProps(state, { expanded: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaceProps(state).error).toBe("temporary failure");

      const props = workspaceProps(state);
      props.onSearch("checklist");
      props.onRetry();
      await vi.advanceTimersByTimeAsync(160);

      expect(listFiles).toHaveBeenCalledTimes(2);
      expect(listFiles).toHaveBeenLastCalledWith("agent:main:current", {
        agentId: "main",
        path: "",
        search: "checklist",
      });
      expect(workspaceProps(state).browserSearch).toBe("checklist");
      expect(workspaceProps(state).error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "Files is closed or inactive", options: { expanded: false }, terminal: true },
    {
      label: "the chat pane is hidden before its pending search runs",
      options: { expanded: true, presented: false },
      terminal: false,
    },
  ])("keeps a revealed workspace cold when $label", async ({ options, terminal }) => {
    vi.useFakeTimers();
    try {
      const listFiles = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        files: [],
      });
      const state = createLoadingHost({ listFiles });

      workspaceProps(state, { expanded: true });
      await vi.advanceTimersByTimeAsync(0);
      revealSessionWorkspaceFile(state, "src/README.md");
      await vi.advanceTimersByTimeAsync(0);
      expect(listFiles).toHaveBeenCalledTimes(2);

      workspaceProps(state, { expanded: true }).onSearch("hidden");
      if (terminal) {
        refreshSessionWorkspace(state, false);
      }
      workspaceProps(state, options);

      expect(listFiles).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(160);
      expect(listFiles).toHaveBeenCalledTimes(2);

      workspaceProps(state, { expanded: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(listFiles).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openSessionWorkspaceFile", () => {
  it("keeps same-path sender files distinct and sends every file operation to its owner", async () => {
    const path = "index.html";
    const owner = "agent:research:report";
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
      sessionKey,
      root: "/shared",
      file: textFile(path, "hello", { workspacePath: path, hash: "old" }),
    }));
    const setFile = vi.fn<SessionWorkspaceHost["sessions"]["setFile"]>(
      async (sessionKey, savedPath, content) => ({
        sessionKey,
        root: "/shared",
        file: workspaceFile(savedPath, { content, hash: "new", kind: "modified" }),
      }),
    );
    const state: SessionWorkspaceHost = createHost({
      client: createGatewayBrowserClientFixture(),
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods(["sessions.files.set"]),
      sessionKey: "agent:main:viewer",
      sessions: createSessionCapabilityFixture({ getFile, setFile }),
    });
    const fileReady = () => {
      const current = state.sessionWorkspaceState;
      return (
        current?.previews.find((entry) => entry.id === current.activePreviewId)?.content.kind ===
        "file"
      );
    };
    let completed = nextWorkspaceUpdate(state, fileReady);
    void openSessionWorkspaceFile(state, { path, sessionKey: owner });
    await completed;
    const workspace = state.sessionWorkspaceState;
    const file = workspace?.previews[0]?.content;
    expect(getFile).toHaveBeenCalledExactlyOnceWith(owner, path, { agentId: "research" });
    expect(workspace?.sessionKey).toBe(state.sessionKey);
    if (file?.kind !== "file" || !file.edit) {
      throw new Error("Expected an editable sender file");
    }
    expect(file.sessionFileSource).toEqual({ sessionKey: owner, agentId: "research", path });
    await file.edit.fetchLatest();
    expect(getFile).toHaveBeenLastCalledWith(owner, path, { agentId: "research" });
    await file.edit.save({ content: "changed", expectedHash: "old" });
    expect(setFile).toHaveBeenCalledExactlyOnceWith(owner, path, "changed", {
      agentId: "research",
      expectedHash: "old",
    });

    completed = nextWorkspaceUpdate(state, fileReady);
    void openSessionWorkspaceFile(state, { path });
    await completed;
    expect(workspace?.previews).toHaveLength(2);
    const viewerFile = workspace?.previews[1]?.content;
    expect(viewerFile?.kind).toBe("file");
    if (viewerFile?.kind === "file") {
      expect(viewerFile.draftKey).not.toBe(file.draftKey);
    }
    expect(getFile).toHaveBeenLastCalledWith(state.sessionKey, path, { agentId: "main" });
  });

  it.each(["workspaceId", "root", "fileRoot"] as const)(
    "keeps hash-conflict recovery on the opened source when %s changes",
    async (field) => {
      const originalSource = {
        workspaceId: "managed-a",
        root: "/workspace",
        fileRoot: "/workspace",
      };
      let source = originalSource;
      const getFile = vi.fn(async () => ({
        sessionKey: "agent:main:current",
        root: "/workspace",
        source,
        file: textFile("notes.md", "before", { hash: "old" }),
      }));
      const message = "The file's workspace changed. Reopen the file before saving.";
      const setFile = vi.fn().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message,
          details: { type: "session_file_source_changed" },
        }),
      );
      const state = createLoadingHost(
        { getFile, setFile, listFiles: vi.fn(async () => workspaceList(source.root)) },
        {
          handleOpenSidebar: createSidebarContentRecorder(),
          hello: gatewayHelloForMethods(["sessions.files.set"]),
        },
      );
      void openSessionWorkspaceFile(state, { path: "notes.md" });
      const file = await loadedSidebarContent(state);
      if (file?.kind !== "file" || !file.edit) {
        throw new Error("Expected an editable file");
      }
      expect(await file.edit.fetchLatest()).toMatchObject({ content: "before", hash: "old" });
      source = { ...originalSource, [field]: `${originalSource[field]}-replacement` };
      expect(await file.edit.fetchLatest()).toBeNull();
      expect(
        await file.edit.save({ content: "retained draft", expectedHash: "old" }),
      ).toMatchObject({
        ok: false,
        code: "error",
        message: expect.stringContaining("workspace changed"),
      });
      expect(setFile).toHaveBeenLastCalledWith("agent:main:current", "notes.md", "retained draft", {
        agentId: "main",
        expectedHash: "old",
        expectedSource: originalSource,
      });
      const reopened = nextWorkspaceUpdate(
        state,
        () => state.sessionWorkspaceState?.previews[0]?.content !== file,
      );
      void openSessionWorkspaceFile(state, { path: "notes.md" });
      await reopened;
      const fresh = await loadedSidebarContent(state);
      if (fresh.kind !== "file" || !fresh.edit) {
        throw new Error("Expected the freshly opened file");
      }
      expect(fresh.draftKey).not.toBe(file.draftKey);
      await fresh.edit.save({ content: "fresh draft", expectedHash: "old" });
      expect(setFile).toHaveBeenLastCalledWith("agent:main:current", "notes.md", "fresh draft", {
        agentId: "main",
        expectedHash: "old",
        expectedSource: source,
      });
    },
  );

  it.each(["current", "forwarded", "navigated"] as const)(
    "refreshes only the owning listing after a source-change refusal (%s)",
    async (view) => {
      const oldSource = {
        workspaceId: "managed-a",
        root: "/workspace/a",
        fileRoot: "/workspace/a",
      };
      const newSource = { ...oldSource, root: "/workspace/b", fileRoot: "/workspace/b" };
      const key = view === "forwarded" ? "agent:main:other" : "agent:main:current";
      const getFile = vi
        .fn()
        .mockResolvedValueOnce({
          sessionKey: key,
          root: oldSource.root,
          source: oldSource,
          file: textFile("notes.md", "before", { hash: "old" }),
        })
        .mockResolvedValueOnce({
          sessionKey: key,
          root: newSource.root,
          source: newSource,
          file: textFile("notes.md", "before", { hash: "old" }),
        });
      const refreshed = createDeferred<SessionWorkspaceListResult>();
      const listFiles = vi.fn(() => refreshed.promise);
      const setFile = vi.fn().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Workspace changed",
          details: { type: "session_file_source_changed" },
        }),
      );
      const state = createLoadingHost(
        { getFile, setFile, listFiles },
        {
          handleOpenSidebar: createSidebarContentRecorder(),
          hello: gatewayHelloForMethods(["sessions.files.set"]),
        },
      );
      const workspace = getSessionWorkspace(state);
      workspace.list = workspaceList(oldSource.root);
      if (view === "forwarded") {
        void openSessionWorkspaceFile(state, { path: "notes.md", sessionKey: key });
      } else {
        workspaceProps(state).onOpenFile("notes.md", "workspace");
      }
      const file = await loadedSidebarContent(state);
      if (file.kind !== "file" || !file.edit) {
        throw new Error("Expected an editable file");
      }
      const saving = file.edit.save({ content: "retained draft", expectedHash: "old" });
      if (view === "navigated") {
        state.sessionKey = "agent:main:next";
      }
      expect(await saving).toMatchObject({ ok: false, code: "error" });
      expect(workspace.previews.some((preview) => preview.content === file)).toBe(true);
      if (view !== "current") {
        expect(listFiles).not.toHaveBeenCalled();
        expect(workspace.list?.root).toBe(oldSource.root);
        return;
      }
      expect(listFiles).toHaveBeenCalledOnce();
      expect(workspace.list).toBeNull();
      const loaded = nextWorkspaceUpdate(state, () => workspace.list?.root === newSource.root);
      refreshed.resolve(workspaceList(newSource.root));
      await loaded;
      workspaceProps(state).onOpenFile("notes.md", "workspace");
      const fresh = await loadedSidebarContent(state);
      expect(fresh.kind === "file" && fresh.edit).toBeTruthy();
      expect(getFile).toHaveBeenLastCalledWith(key, "/workspace/b/notes.md", { agentId: "main" });
    },
  );

  it("preserves existing Review content when the Gateway is disconnected", () => {
    const existingContent = {
      kind: "markdown",
      content: "Existing review",
      rawText: "Existing review",
    } satisfies SidebarContent;
    let sidebarContent: SidebarSelection | null = existingContent;
    const handleOpenSidebar = vi.fn((content: SidebarSelection | null) => {
      sidebarContent = content;
    });
    const getFile = vi.fn();
    const state = createHost({
      client: {},
      connected: false,
      handleOpenSidebar,
      hello: gatewayHelloForMethods([]),
      sidebarContent: existingContent,
      sessions: { getFile },
    }) as unknown as SessionWorkspaceHost;

    void openSessionWorkspaceFile(state, { path: "README.md" });

    expect(getFile).not.toHaveBeenCalled();
    expect(handleOpenSidebar).not.toHaveBeenCalled();
    expect(sidebarContent).toBe(existingContent);
  });

  it("opens Markdown with a canonical Gateway- and pane-scoped draft identity", async () => {
    const handleOpenSidebar = createSidebarContentRecorder();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      file: textFile("README.md", "# Before\n", {
        workspacePath: "README.md",
        hash: "a".repeat(64),
      }),
    });
    const state = createHost({
      client: {},
      handleOpenSidebar,
      hello: gatewayHelloForMethods(["sessions.files.set"]),
      sessionWorkspaceDraftScope: "pane-left",
      sessionWorkspaceDraftContext: { sessionTitle: "Research", paneLabel: "Column 1, row 1" },
      settings: { gatewayUrl: "wss://gateway-a.example" },
      sessions: { getFile },
    }) as unknown as SessionWorkspaceHost;

    void openSessionWorkspaceFile(state, { path: "readme.md" });
    state.sessionWorkspaceDraftContext = {
      sessionTitle: "Later selection",
      paneLabel: "Column 2, row 1",
    };

    expect(await loadedSidebarContent(state)).toMatchObject({
      kind: "file",
      name: "README.md",
      content: "# Before\n",
      draftKey:
        "wss://gateway-a.example\u0000pane-left\u0000agent:main:current\u0000/workspace\u0000README.md",
      draftContext: {
        sessionKey: "agent:main:current",
        sessionTitle: "Research",
        paneLabel: "Column 1, row 1",
      },
      edit: { hash: "a".repeat(64) },
    });
  });

  it.each(["current", "replaced"] as const)(
    "refreshes saved file metadata only for its %s workspace",
    async (scope) => {
      const saved = createDeferred<{ file: { hash: string } }>();
      const state = createHost({
        client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
        connectionEpoch: 1,
        handleOpenSidebar: createSidebarContentRecorder(),
        hello: gatewayHelloForMethods(["sessions.files.set", "sessions.diff"]),
        sessions: {
          getFile: vi.fn().mockResolvedValue({
            sessionKey: "agent:main:current",
            root: "/workspace",
            file: {
              path: "notes.md",
              name: "notes.md",
              previewKind: "text",
              contentEncoding: "utf8",
              content: "before",
              hash: "old",
            },
          }),
          setFile: vi.fn(() => saved.promise),
          listFiles: vi.fn().mockResolvedValue({
            sessionKey: "agent:main:current",
            files: [{ path: "notes.md", name: "notes.md", kind: "modified", size: 130 }],
          }),
        },
      }) as unknown as SessionWorkspaceHost;
      const opened = nextWorkspaceUpdate(
        state,
        () => state.sessionWorkspaceState?.previews[0]?.content.kind === "file",
      );
      void openSessionWorkspaceFile(state, { path: "notes.md" });
      await opened;
      const file = await loadedSidebarContent(state);
      if (file.kind !== "file" || !file.edit) {
        throw new Error("Expected an editable workspace file");
      }
      const workspace = state.sessionWorkspaceState!;
      workspace.browserSearch = "notes";
      const oldDiff = resolveSessionDiffSidebarContent(state);
      state.sidebarContent = oldDiff;
      const savedUpdate = nextWorkspaceUpdate(state, () => !workspace.loading);
      const saving = file.edit.save({ content: "after — café 雪 🦞", expectedHash: "old" });
      if (scope === "replaced") {
        state.connectionEpoch += 1;
        workspaceProps(state);
      }
      saved.resolve({ file: { hash: "new" } });
      await expect(saving).resolves.toMatchObject({ ok: true, hash: "new" });
      if (scope === "replaced") {
        expect(state.sessions.listFiles).not.toHaveBeenCalled();
        expect(state.sessionWorkspaceState?.list).toBeNull();
      } else {
        expect(state.sessions.listFiles).toHaveBeenCalledWith(state.sessionKey, {
          path: "",
          search: "notes",
          agentId: "main",
        });
        await savedUpdate;
        expect(state.sidebarContent).not.toBe(oldDiff);
        expect(state.handleOpenSidebar).toHaveBeenCalledOnce();
        expect(state.sessionWorkspaceState).toBe(workspace);
        expect(workspace.list?.files[0]?.size).toBe(130);
      }
    },
  );

  it("keeps Markdown read-only when the connection lacks admin scope", async () => {
    const content = await readPreview(
      textFile("README.md", "# Before\n", { hash: "a".repeat(64) }),
      gatewayHelloForMethods(["sessions.files.set"], ["operator.read"]),
    );
    expect(content).toMatchObject({ kind: "file" });
    expect(content.kind === "file" ? content.edit : undefined).toBeUndefined();
  });

  it.each([
    { root: "/workspace", expected: "/workspace/src/readme.md" },
    { root: "C:\\workspace", expected: "C:\\workspace\\src\\readme.md" },
  ])(
    "keeps the opened workspace-browser row selected beneath $root across refresh",
    async ({ root, expected }) => {
      const getFile = vi.fn().mockImplementation(async (_sessionKey, requestedPath) => ({
        sessionKey: "agent:main:current",
        root,
        file: textFile(requestedPath, "# Browser file\n", {
          workspacePath:
            requestedPath === "src/readme.md" ? "nested/src/readme.md" : "src/readme.md",
        }),
      }));
      const listFiles = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        root,
        files: [
          workspaceFile(expected, { kind: "modified", workspacePath: "src/readme.md" }),
          workspaceFile("src/readme.md", { workspacePath: "nested/src/readme.md" }),
        ],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "readme.md", path: "src/readme.md" }],
        },
      });
      const state = createHost({
        client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
        hello: gatewayHelloForMethods([]),
        sessions: { getFile, listFiles },
      }) as unknown as SessionWorkspaceHost;

      workspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(workspaceProps(state).list).not.toBeNull());

      const container = document.createElement("div");
      const updateRail = mountWorkspaceRail(container, state);
      const row = container.querySelector<HTMLButtonElement>(
        ".chat-workspace-rail__list--browser .chat-workspace-rail__file-open",
      );
      expect(row).toBeInstanceOf(HTMLButtonElement);
      row!.click();

      await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
      expect(getFile.mock.calls[0]?.[1]).toBe(expected);
      const expectSelectedRow = (selectedPath = "src/readme.md") => {
        updateRail();
        const browserSelected = container.querySelector(
          ".chat-workspace-rail__list--browser .chat-workspace-rail__file--active",
        );
        expect(Boolean(browserSelected)).toBe(selectedPath === "src/readme.md");
        const selectedSessionRows = container.querySelectorAll(
          ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file--active .chat-workspace-rail__file-open",
        );
        expect(
          Array.from(selectedSessionRows, (selectedRow) => selectedRow.getAttribute("aria-label")),
        ).toEqual([selectedPath === "src/readme.md" ? expected : "src/readme.md"]);
      };
      await vi.waitFor(() => expectSelectedRow());
      const changedRow = container.querySelector<HTMLButtonElement>(
        ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file-open",
      );
      changedRow!.click();
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
      expectSelectedRow();
      expect(state.sessionWorkspaceState?.previews).toHaveLength(1);
      loadSessionWorkspace(state, getSessionWorkspace(state), true);
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(workspaceProps(state).loading).toBe(false));
      expectSelectedRow();
      const nestedRow = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file-open",
        ),
      ).at(-1)!;
      nestedRow.click();
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(3));
      expect(getFile.mock.calls[2]?.[1]).toBe("src/readme.md");
      await vi.waitFor(() => expectSelectedRow("nested/src/readme.md"));
      expect(state.sessionWorkspaceState?.previews).toHaveLength(2);
    },
  );

  it.each([
    ["image", imageFile("image/png")],
    ["unsafe image", imageFile("image/svg+xml")],
    [
      "unencoded text",
      workspaceFile("notes.txt", {
        previewKind: "text",
        contentEncoding: undefined,
        content: "bm90ZXM=",
      }),
    ],
  ] as const)("validates %s previews", async (kind, file) => {
    const methods = kind === "unencoded text" ? ["sessions.files.get", "sessions.diff"] : [];
    const state = createFileHost(file, gatewayHelloForMethods(methods));
    void openSessionWorkspaceFile(state, { path: file.path });
    if (kind === "image") {
      expect(await loadedSidebarContent(state)).toMatchObject({
        kind: "image",
        mimeType: "image/png",
        src: "data:image/png;base64,iVBORw0KGgo=",
        title: "result.png",
      });
    } else {
      await expectUnavailable(state, `Failed to load ${file.path}`);
      if (kind === "unencoded text") {
        const diff = resolveSessionDiffSidebarContent(state);
        expect(diff?.kind).toBe("session-diff");
        if (diff?.kind === "session-diff") {
          await expect(diff.loadFileText?.(file.path)).resolves.toBeNull();
        }
      }
    }
  });

  it.each([
    { error: new Error("session file not found"), message: "session file not found" },
    {
      error: new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "session file not found",
        details: { type: "session_file_not_found", reason: "outside_session_boundary" },
      }),
      message: "This file is outside Main Session's workspace, and you can't open it.",
    },
  ])("keeps a rejected file open with its reason: $message", async ({ error, message }) => {
    const handleOpenSidebar = createSidebarContentRecorder();
    const state: SessionWorkspaceHost = createHost({
      client: createGatewayBrowserClientFixture(),
      connectionEpoch: 1,
      handleOpenSidebar,
      hello: gatewayHelloForMethods([]),
      sessions: createSessionCapabilityFixture({
        getFile: vi.fn().mockRejectedValue(error),
      }),
    });
    const completed = nextWorkspaceUpdate(
      state,
      () => state.sessionWorkspaceState?.previews.at(-1)?.content.kind === "unavailable",
    );

    void openSessionWorkspaceFile(state, {
      path: "/outside/workspace/chat.md",
      sessionKey: "agent:research:main",
    });

    await completed;
    expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toEqual({
      kind: "unavailable",
      message,
    });
    expect(workspaceProps(state).error).toBe(message);
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "binary metadata",
      file: workspaceFile("build/cache.db", {
        mimeType: "application/x-sqlite3",
        previewKind: "unsupported",
        size: 8192,
        updatedAtMs: 1_700_000_000_000,
      }),
      contains: [
        "This file is not previewable inline.",
        "application/x-sqlite3",
        "8,192 bytes",
        "2023-11-14T22:13:20.000Z",
      ],
      excludes: [],
    },
    {
      label: "hostile filename literally",
      file: workspaceFile(" build/`\n\n![remote](https://example.com/x) report~~old~~&amp;.db ", {
        name: "cache.db",
        mimeType: "application/octet-stream",
        previewKind: "unsupported",
        updatedAtMs: Number.MAX_VALUE,
      }),
      contains: ["``  build/`\\n\\n![remote](https://example.com/x) report~~old~~&amp;.db  ``"],
      excludes: ["\n\n![remote]", "Updated:"],
    },
  ])("renders unsupported $label", async ({ file, contains, excludes }) => {
    const preview = await readPreview(file);
    expect(preview).toMatchObject({ kind: "markdown" });
    const content = preview.kind === "markdown" ? preview.content : "";
    for (const fragment of contains) {
      expect(content).toContain(fragment);
    }
    for (const fragment of excludes) {
      expect(content).not.toContain(fragment);
    }
  });
});
