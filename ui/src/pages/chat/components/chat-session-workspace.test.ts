import { createComponent, createSignal, flush } from "solid-js";
import { assert, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../../../api/types.ts";
import { useFakeClock } from "../../../test-helpers/fake-clock.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
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
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

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
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toEqual({
    kind: "unavailable",
    message,
  });
}

function createLoadingHost(sessions: object, overrides: object = {}): SessionWorkspaceHost {
  return {
    client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
    connected: true,
    connectionEpoch: 1,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    handleOpenSidebar: createSidebarContentRecorder(),
    hello: null,
    sessionKey: "agent:main:current",
    sidebarContent: null,
    sessions,
    ...overrides,
  } as unknown as SessionWorkspaceHost;
}

function createFileHost(
  file: SessionWorkspaceGetResult["file"],
  hello = gatewayHelloForMethods([]),
  overrides: object = {},
): SessionWorkspaceHost {
  return createLoadingHost(
    { getFile: vi.fn().mockResolvedValue(fileResult(file)) },
    {
      client: {},
      hello,
      ...overrides,
    },
  );
}

function fileResult(
  file: SessionWorkspaceGetResult["file"],
  overrides: Partial<SessionWorkspaceGetResult> = {},
): SessionWorkspaceGetResult {
  return { sessionKey: "agent:main:current", file, ...overrides };
}

type EditableFile = Extract<SidebarContent, { kind: "file" }>;
function assertEditable(
  file: SidebarContent,
): asserts file is EditableFile & { edit: NonNullable<EditableFile["edit"]> } {
  assert(file.kind === "file" && file.edit, "Expected an editable file");
}
async function editableContent(state: SessionWorkspaceHost, path?: string, sessionKey?: string) {
  if (path) {
    await openSessionWorkspaceFile(state, { path, sessionKey });
  }
  const file = await loadedSidebarContent(state);
  assertEditable(file);
  return file;
}

const sourceChanged = new GatewayRequestError({
  code: "INVALID_REQUEST",
  message: "The file's workspace changed. Reopen the file before saving.",
  details: { type: "session_file_source_changed" },
});
const sourceA = { workspaceId: "managed-a", root: "/workspace/a", fileRoot: "/workspace/a" };

function editableHost(sessions: object, overrides: object = {}) {
  return createLoadingHost(sessions, {
    hello: gatewayHelloForMethods(["sessions.files.set"]),
    ...overrides,
  });
}

function noteResult(overrides: Partial<SessionWorkspaceGetResult> = {}) {
  return fileResult(textFile("notes.md", "before", { hash: "old" }), overrides);
}

function diffHost(request: object) {
  const state = createLoadingHost(
    {},
    {
      client: { request },
      hello: gatewayHelloForMethods(["sessions.diff"]),
    },
  );
  const content = resolveSessionDiffSidebarContent(state);
  assert(content?.kind === "session-diff");
  return { state, content };
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

describe("session workspace state", () => {
  it("keeps filter changes in the current session and resets them for a new session", () => {
    const state = createLoadingHost({}, { client: null, connected: false });
    const workspace = workspaceProps(state);
    expect(workspace.filter).toBe("all");
    const owner = sessionWorkspaceForHost(state);
    let published: string | undefined;
    const stop = owner.subscribe(() => {
      published = workspaceProps(state).filter;
    });
    workspace.onSetFilter("read");
    expect(workspaceProps(state).filter).toBe("read");
    expect(published).toBe("read");
    stop();

    state.sessionKey = "agent:main:next";
    expect(workspaceProps(state).filter).toBe("all");
  });

  it("keeps Files loading until files and artifacts both settle", async () => {
    const list = createDeferred<SessionWorkspaceListResult>();
    const listFiles = vi.fn(() => list.promise);
    const artifacts = createDeferred<{ artifacts: [] }>();
    const request = vi.fn(() => artifacts.promise);
    const state = createLoadingHost({ listFiles }, { client: { request } });
    expect(workspaceProps(state, { expanded: true }).loading).toBe(true);

    list.resolve(
      workspaceList("/workspace/cloud", {
        sessionKey: state.sessionKey,
        files: [workspaceFile("src/slow.ts", { kind: "modified" })],
      }),
    );
    await Promise.resolve();
    expect(workspaceProps(state)).toMatchObject({ loading: true, list: null });
    artifacts.resolve({ artifacts: [] });
    await vi.waitFor(() => expect(workspaceProps(state).loading).toBe(false));
    expect(workspaceProps(state).list?.files[0]?.path).toBe("src/slow.ts");
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
    workspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(workspaceProps(state).list?.root).toBe("/checkout/a"));
    const oldDiff = resolveSessionDiffSidebarContent(state);
    expect(oldDiff?.kind).toBe("session-diff");
    workspaceProps(state, { expanded: true }).onOpenDiff?.();
    expect(state.sidebarContent).toBe(oldDiff);
    void openSessionWorkspaceFile(state, { path: "README.md" });
    expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("loading");
    loadSessionWorkspace(state, getSessionWorkspace(state), true);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));

    state.connectionEpoch = 2;
    const pending = workspaceProps(state, { expanded: true });

    expect(pending).toMatchObject({ list: null, onOpenDiff: expect.any(Function) });
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(state.sidebarContent).toBeNull();

    oldFile.resolve(fileResult(textFile("README.md", "old checkout"), { root: "/checkout/a" }));
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

  it("refreshes the diff owner while an older uncommitted poll is pending", async () => {
    const original: SessionsDiffResult = {
      sessionKey: "agent:main:current",
      files: [],
      additions: 0,
      deletions: 0,
      branch: "original",
    };
    const updated = { ...original, branch: "updated" };
    const pending = createDeferred<SessionsDiffResult>();
    let holdPoll = false;
    const { content } = diffHost((_method: string, params: { poll?: boolean }) =>
      params.poll
        ? holdPoll
          ? pending.promise
          : Promise.resolve(original)
        : Promise.resolve(updated),
    );
    await content.load({ scope: "uncommitted" });
    expect(content.uncommitted).toBe(original);
    holdPoll = true;
    const polling = content.load({ scope: "uncommitted" });
    try {
      await content.load({ scope: "uncommitted" }, { refresh: true });
      expect(content.uncommitted).toBe(updated);
    } finally {
      pending.resolve(original);
      await polling;
    }
    expect(content.uncommitted).toBe(updated);
  });

  it("retains uncommitted changes while computing and retires retries with visible demand", async () => {
    useFakeClock();
    const result = {
      sessionKey: "agent:main:current",
      files: [{ path: "changed.ts", status: "modified", additions: 2, deletions: 1 }],
      additions: 2,
      deletions: 1,
    };
    const computing = { ...result, files: [], additions: 0, deletions: 0, computing: true };
    const request = vi.fn().mockResolvedValueOnce(computing).mockResolvedValue(result);
    const { state, content } = diffHost(request);
    const stop = content.requestUncommitted?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(content.uncommitted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(content.uncommitted).toBe(result);
    stop?.();
    request.mockResolvedValue(computing);
    const stopRefresh = content.requestUncommitted?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(content.uncommitted).toBe(result);
    stopRefresh?.();
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
    useFakeClock();
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
  });

  it.each([
    { label: "Files is closed or inactive", options: { expanded: false }, terminal: true },
    {
      label: "the chat pane is hidden before its pending search runs",
      options: { expanded: true, presented: false },
      terminal: false,
    },
  ])("keeps a revealed workspace cold when $label", async ({ options, terminal }) => {
    useFakeClock();
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
  });
});

describe("openSessionWorkspaceFile", () => {
  it("admits a preview synchronously but does not start its read after reconnect", async () => {
    const state = createFileHost(textFile("old.md", "old"));
    state.connectionEpoch = 1;
    const opening = openSessionWorkspaceFile(state, { path: "old.md" });
    expect(state.sessionWorkspaceState?.activePreviewId).toBe("file:old.md");
    expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("loading");
    state.connectionEpoch += 1;
    const current = getSessionWorkspace(state);
    await opening;
    expect(state.sessions.getFile).not.toHaveBeenCalled();
    expect(current.previews).toEqual([]);
  });

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
    const state = createLoadingHost(
      { getFile, setFile },
      {
        hello: gatewayHelloForMethods(["sessions.files.set"]),
        sessionKey: "agent:main:viewer",
      },
    );
    const file = await editableContent(state, path, owner);
    const workspace = state.sessionWorkspaceState;
    expect(getFile).toHaveBeenCalledExactlyOnceWith(owner, path, { agentId: "research" });
    expect(workspace?.sessionKey).toBe(state.sessionKey);
    expect(file.sessionFileSource).toEqual({ sessionKey: owner, agentId: "research", path });
    await file.edit.fetchLatest();
    expect(getFile).toHaveBeenLastCalledWith(owner, path, { agentId: "research" });
    await file.edit.save({ content: "changed", expectedHash: "old" });
    expect(setFile).toHaveBeenCalledExactlyOnceWith(owner, path, "changed", {
      agentId: "research",
      expectedHash: "old",
    });

    const viewerFile = await editableContent(state, path);
    expect(workspace?.previews).toHaveLength(2);
    expect(viewerFile.draftKey).not.toBe(file.draftKey);
    expect(getFile).toHaveBeenLastCalledWith(state.sessionKey, path, { agentId: "main" });
  });

  it.each(["workspaceId", "root", "fileRoot"] as const)(
    "keeps hash-conflict recovery on the opened source when %s changes",
    async (field) => {
      let source = sourceA;
      const getFile = vi.fn(async () => noteResult({ source, root: source.root }));
      const setFile = vi.fn().mockRejectedValue(sourceChanged);
      const state = editableHost({
        getFile,
        setFile,
        listFiles: vi.fn(async () => workspaceList(source.root)),
      });
      const file = await editableContent(state, "notes.md");
      expect(await file.edit.fetchLatest()).toMatchObject({ content: "before", hash: "old" });
      source = { ...sourceA, [field]: `${sourceA[field]}-replacement` };
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
        expectedSource: sourceA,
      });
      const fresh = await editableContent(state, "notes.md");
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
      const newSource = { ...sourceA, root: "/workspace/b", fileRoot: "/workspace/b" };
      const key = view === "forwarded" ? "agent:main:other" : "agent:main:current";
      const result = (source: typeof sourceA) =>
        noteResult({
          sessionKey: key,
          root: source.root,
          source,
        });
      const getFile = vi
        .fn()
        .mockResolvedValueOnce(result(sourceA))
        .mockResolvedValueOnce(result(newSource));
      const refreshed = createDeferred<SessionWorkspaceListResult>();
      const listFiles = vi.fn(() => refreshed.promise);
      const setFile = vi.fn().mockRejectedValue(sourceChanged);
      const state = editableHost({ getFile, setFile, listFiles });
      const workspace = getSessionWorkspace(state);
      workspace.list = workspaceList(sourceA.root);
      if (view === "forwarded") {
        void openSessionWorkspaceFile(state, { path: "notes.md", sessionKey: key });
      } else {
        workspaceProps(state).onOpenFile("notes.md", "workspace");
      }
      const file = await editableContent(state);
      const saving = file.edit.save({ content: "retained draft", expectedHash: "old" });
      if (view === "navigated") {
        state.sessionKey = "agent:main:next";
      }
      expect(await saving).toMatchObject({ ok: false, code: "error" });
      expect(workspace.previews.some((preview) => preview.content === file)).toBe(true);
      if (view !== "current") {
        expect(listFiles).not.toHaveBeenCalled();
        expect(workspace.list?.root).toBe(sourceA.root);
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
    const state = createFileHost(textFile("README.md", "ignored"), undefined, {
      connected: false,
      sidebarContent: existingContent,
    });
    void openSessionWorkspaceFile(state, { path: "README.md" });
    expect(state.sessions.getFile).not.toHaveBeenCalled();
    expect(state.handleOpenSidebar).not.toHaveBeenCalled();
    expect(state.sidebarContent).toBe(existingContent);
  });

  it("opens Markdown with a canonical Gateway- and pane-scoped draft identity", async () => {
    const state = editableHost(
      {
        getFile: vi.fn().mockResolvedValue(
          fileResult(
            textFile("README.md", "# Before\n", {
              workspacePath: "README.md",
              hash: "a".repeat(64),
            }),
            { root: "/workspace" },
          ),
        ),
      },
      {
        sessionWorkspaceDraftScope: "pane-left",
        sessionWorkspaceDraftContext: { sessionTitle: "Research", paneLabel: "Column 1, row 1" },
        settings: { gatewayUrl: "wss://gateway-a.example" },
      },
    );

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
      const state = editableHost(
        {
          getFile: vi.fn().mockResolvedValue(noteResult({ root: "/workspace" })),
          setFile: vi.fn(() => saved.promise),
          listFiles: vi.fn().mockResolvedValue({
            sessionKey: "agent:main:current",
            files: [{ path: "notes.md", name: "notes.md", kind: "modified", size: 130 }],
          }),
        },
        { hello: gatewayHelloForMethods(["sessions.files.set", "sessions.diff"]) },
      );
      const file = await editableContent(state, "notes.md");
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
      const state = createLoadingHost({ getFile, listFiles });
      workspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(workspaceProps(state).list).not.toBeNull());
      const [props, setProps] = createSignal(workspaceProps(state));
      const { container } = mountSolid(() =>
        createComponent(SessionWorkspaceRail, {
          get workspace() {
            return props();
          },
        }),
      );
      const expectSelection = (path: string) =>
        vi.waitFor(() => {
          setProps(workspaceProps(state));
          flush();
          const selected = ".chat-workspace-rail__file--active .chat-workspace-rail__file-open";
          expect(
            container.querySelector(`.chat-workspace-rail__list--browser ${selected}`) !== null,
          ).toBe(path === expected);
          expect(
            Array.from(
              container.querySelectorAll(
                `.chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) ${selected}`,
              ),
              (row) => row.getAttribute("aria-label"),
            ),
          ).toEqual([path]);
        });
      workspaceProps(state).onOpenFile("src/readme.md", "workspace");
      const file = await loadedSidebarContent(state);
      assert(file.kind === "file");
      expect(file.sessionFileSource?.path).toBe(expected);
      const workspace = getSessionWorkspace(state);
      const selected = workspace.activeId;
      await expectSelection(expected);
      await openSessionWorkspaceFile(state, { path: expected });
      expect(workspace.previews).toHaveLength(1);
      expect(workspace.activeId).toBe(selected);
      loadSessionWorkspace(state, workspace, true);
      await vi.waitFor(() => expect(workspaceProps(state).loading).toBe(false));
      expect(workspace.activeId).toBe(selected);
      await expectSelection(expected);
      await openSessionWorkspaceFile(state, { path: "src/readme.md" });
      expect(workspace.activeId).not.toBe(selected);
      expect(workspace.previews).toHaveLength(2);
      const nested = await loadedSidebarContent(state);
      expect(nested).toMatchObject({ kind: "file", path: "nested/src/readme.md" });
      await expectSelection("src/readme.md");
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

  it("keeps an outside-session refusal open with its reason", async () => {
    const message = "This file is outside Main Session's workspace, and you can't open it.";
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "session file not found",
      details: { type: "session_file_not_found", reason: "outside_session_boundary" },
    });
    const state = createLoadingHost({ getFile: vi.fn().mockRejectedValue(error) });
    await openSessionWorkspaceFile(state, {
      path: "/outside/workspace/chat.md",
      sessionKey: "agent:research:main",
    });
    await expectUnavailable(state, message);
  });

  it("renders unsupported binary metadata", async () => {
    const preview = await readPreview(
      workspaceFile("build/cache.db", {
        mimeType: "application/x-sqlite3",
        previewKind: "unsupported",
        size: 8192,
        updatedAtMs: 1_700_000_000_000,
      }),
    );
    assert(preview.kind === "markdown");
    expect(preview.content).toContain("This file is not previewable inline.");
    expect(preview.content).toContain("application/x-sqlite3");
    expect(preview.content).toContain("8,192 bytes");
    expect(preview.content).toContain("2023-11-14T22:13:20.000Z");
  });

  it("renders unsupported hostile filenames literally without invalid dates", async () => {
    const preview = await readPreview(
      workspaceFile(" build/`\n\n![remote](https://example.com/x) report~~old~~&amp;.db ", {
        name: "cache.db",
        mimeType: "application/octet-stream",
        previewKind: "unsupported",
        updatedAtMs: Number.MAX_VALUE,
      }),
    );
    assert(preview.kind === "markdown");
    expect(preview.content).toContain(
      "``  build/`\\n\\n![remote](https://example.com/x) report~~old~~&amp;.db  ``",
    );
    expect(preview.content).not.toContain("\n\n![remote]");
    expect(preview.content).not.toContain("Updated:");
  });
});
