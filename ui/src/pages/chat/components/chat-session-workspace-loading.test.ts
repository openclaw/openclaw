import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  projectWorkspaceCatalog,
  workspaceCatalogChildren,
  workspaceCatalogFilters,
  workspaceCatalogSearch,
  splitWorkspaceFilename,
} from "./chat-session-workspace-catalog.ts";
import {
  getSessionWorkspace,
  loadSessionWorkspace,
  loadSessionWorkspaceArtifacts,
  loadSessionWorkspaceDirectory,
  retainSessionWorkspaceArtifacts,
  refreshSessionWorkspaceState,
} from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

async function fixture({ loadInitialListing = true } = {}) {
  const { promise: pending, resolve, reject } = createDeferred<SessionWorkspaceListResult>();
  const listing: SessionWorkspaceListResult = {
    sessionKey: "agent:main:current",
    files: [],
    browser: { path: "", entries: [] },
  };
  const listFiles = vi
    .fn()
    .mockResolvedValueOnce(listing)
    .mockReturnValueOnce(pending)
    .mockResolvedValue(listing);
  const state: SessionWorkspaceHost = {
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    connected: true,
    connectionEpoch: 1,
    sessionKey: listing.sessionKey,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    sidebarContent: null,
    handleOpenSidebar: () => {},
    sessions: createSessionCapabilityFixture({
      listFiles,
      getFile: async () => ({
        sessionKey: listing.sessionKey,
        file: {
          path: "reports/inventory.csv",
          name: "inventory.csv",
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content: "item,count\nnotebooks,3",
        },
      }),
    }),
  };
  const props = () => createSessionWorkspaceProps(state);
  const settled = () => vi.waitFor(() => expect(props().loading).toBe(false));
  const reload = () => loadSessionWorkspace(state, getSessionWorkspace(state), true);
  const openFile = async () => {
    await openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
    );
  };
  if (loadInitialListing) {
    createSessionWorkspaceProps(state, { expanded: true });
    await settled();
  }
  const finish = (outcome: "success" | "failure") =>
    outcome === "success" ? resolve(listing) : reject(new Error("old listing unavailable"));
  return { state, listing, listFiles, resolve, finish, props, settled, reload, openFile };
}

afterEach(() => vi.useRealTimers());

it.each([
  ["directory", "success"],
  ["directory", "failure"],
  ["search", "success"],
  ["search", "failure"],
] as const)("ignores an old %s %s without bypassing query scheduling", async (query, outcome) => {
  const { state, listFiles, finish, props, reload } = await fixture();
  vi.useFakeTimers();
  const searching = query === "search";
  reload();
  props()[searching ? "onSearch" : "onBrowsePath"](searching ? "inventory" : "reports");
  finish(outcome);
  await vi.advanceTimersByTimeAsync(0);
  expect(props()).toMatchObject({ loading: false, error: null, list: null });
  createSessionWorkspaceProps(state, { expanded: true });
  if (searching) {
    expect(listFiles).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(159);
    expect(listFiles).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(listFiles).toHaveBeenCalledTimes(3);
  expect(listFiles).toHaveBeenLastCalledWith(state.sessionKey, {
    path: searching ? "" : "reports",
    search: searching ? "inventory" : "",
    agentId: "main",
  });
});

it.each([false, true])("retains selection across absent rows (reopen=%s)", async (reopen) => {
  const { listing, listFiles, resolve, props, settled, reload, openFile } = await fixture();
  if (reopen) {
    await openFile();
  }
  reload();
  await openFile();
  const selected = props().activeId;
  expect(selected).toBeTruthy();
  resolve(listing);
  await settled();
  expect(props().activeId).toBe(selected);

  reload();
  await settled();
  expect(props().activeId).toBe(selected);
  listFiles.mockResolvedValue({
    ...listing,
    browser: {
      path: "reports",
      entries: [{ kind: "file", name: "inventory.csv", path: "reports/inventory.csv" }],
    },
  });
  props().onBrowsePath("reports");
  await settled();
  expect(props().activeId).toBe(selected);
  expect(props().list?.browser?.entries[0]?.path).toBe("reports/inventory.csv");
});

describe("workspace catalog demand", () => {
  it.each(["refresh", "force"] as const)(
    "does not reuse an old directory request after %s invalidation",
    async (invalidation) => {
      const { state, listing } = await fixture({ loadInitialListing: false });
      const oldResponse = createDeferred<SessionWorkspaceListResult>();
      const freshResponse = createDeferred<SessionWorkspaceListResult>();
      const listFiles = vi
        .fn()
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(freshResponse.promise);
      state.sessions = createSessionCapabilityFixture({ listFiles });
      const oldLoad = loadSessionWorkspaceDirectory(state, "");
      if (invalidation === "refresh") {
        refreshSessionWorkspaceState(state, false);
      } else {
        loadSessionWorkspace(state, getSessionWorkspace(state), true);
      }
      const freshLoad = loadSessionWorkspaceDirectory(state, "");
      expect(listFiles).toHaveBeenCalledTimes(2);
      freshResponse.resolve({
        ...listing,
        browser: { path: "", entries: [{ kind: "file", path: "new.md", name: "new.md" }] },
      });
      await freshLoad;
      oldResponse.resolve({
        ...listing,
        browser: { path: "", entries: [{ kind: "file", path: "old.md", name: "old.md" }] },
      });
      await oldLoad;
      expect(
        getSessionWorkspace(state).directories?.[""]?.browser?.entries.map((entry) => entry.path),
      ).toEqual(["new.md"]);
    },
  );

  it("reloads invalidated in-flight artifacts for Files without retained demand", async () => {
    const { state } = await fixture({ loadInitialListing: false });
    const oldResponse = createDeferred<{
      artifacts: NonNullable<SessionWorkspaceListResult["artifacts"]>;
    }>();
    const freshResponse = createDeferred<{
      artifacts: NonNullable<SessionWorkspaceListResult["artifacts"]>;
    }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(freshResponse.promise);
    state.client = createGatewayBrowserClientFixture({ request });
    createSessionWorkspaceProps(state, { expanded: true });
    const oldLoad = loadSessionWorkspaceArtifacts(state);
    refreshSessionWorkspaceState(state, true);
    oldResponse.resolve({
      artifacts: [{ id: "old", title: "old.txt", type: "file", download: { mode: "bytes" } }],
    });
    await oldLoad;
    expect(request).toHaveBeenCalledTimes(2);
    expect(getSessionWorkspace(state).artifacts?.loaded).toBe(false);
    expect(getSessionWorkspace(state).artifacts?.items).toEqual([]);
    const freshLoad = loadSessionWorkspaceArtifacts(state);
    freshResponse.resolve({
      artifacts: [{ id: "fresh", title: "fresh.txt", type: "file", download: { mode: "bytes" } }],
    });
    await freshLoad;
    expect(getSessionWorkspace(state).artifacts?.items.map((item) => item.id)).toEqual(["fresh"]);
    expect(getSessionWorkspace(state).artifacts?.loaded).toBe(true);
  });

  it("keeps assistant Outputs separate from Files and retains resolved data during refresh errors", async () => {
    const { state, listFiles } = await fixture({ loadInitialListing: false });
    const artifact = (id: string) => ({
      id,
      title: id,
      type: "file",
      download: { mode: "bytes" as const },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ artifacts: [artifact("delivered")] })
      .mockResolvedValueOnce({ artifacts: [artifact("upload"), artifact("delivered")] });
    state.client = createGatewayBrowserClientFixture({ request });
    const release = retainSessionWorkspaceArtifacts(state, "assistant");
    await loadSessionWorkspaceArtifacts(state, false, "assistant");
    await loadSessionWorkspaceArtifacts(state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "artifacts.list", {
      sessionKey: state.sessionKey,
      agentId: "main",
      messageRole: "assistant",
    });
    expect(request).toHaveBeenNthCalledWith(2, "artifacts.list", {
      sessionKey: state.sessionKey,
      agentId: "main",
    });
    expect(getSessionWorkspace(state).assistantArtifacts?.items.map((item) => item.id)).toEqual([
      "delivered",
    ]);
    expect(getSessionWorkspace(state).artifacts?.items.map((item) => item.id)).toEqual([
      "upload",
      "delivered",
    ]);
    expect(listFiles).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error("refresh unavailable"));
    refreshSessionWorkspaceState(state, false);
    await loadSessionWorkspaceArtifacts(state, false, "assistant");
    expect(getSessionWorkspace(state).assistantArtifacts).toMatchObject({
      resolved: true,
      loaded: false,
      loading: false,
      error: "refresh unavailable",
      items: [artifact("delivered")],
    });
    release();
  });

  it("fills filter-expanded ancestors on All without loading unexpanded descendants", async () => {
    const { state, listing } = await fixture({ loadInitialListing: false });
    const listFiles = vi.fn(async (_key: string, options?: { path?: string }) => ({
      ...listing,
      files: [
        {
          path: "src/nested/changed.ts",
          workspacePath: "src/nested/changed.ts",
          name: "changed.ts",
          kind: "modified" as const,
          missing: false,
        },
      ],
      browser: {
        path: options?.path ?? "",
        entries: [{ path: "src/nested/unopened", name: "unopened", kind: "directory" as const }],
      },
    }));
    state.sessions = createSessionCapabilityFixture({ listFiles });
    createSessionWorkspaceProps(state, { expanded: true, presentation: "desktop" });
    await vi.waitFor(() => expect(getSessionWorkspace(state).loading).toBe(false));
    const props = createSessionWorkspaceProps(state, { presentation: "desktop" });
    props.onSetFilter("changed");
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(getSessionWorkspace(state).tree?.expandedPaths).toEqual(["", "src", "src/nested"]);
    props.onSetFilter("all");
    expect(listFiles.mock.calls.map(([, options]) => options?.path)).toEqual([
      "",
      "src",
      "src/nested",
    ]);
    await Promise.all([
      loadSessionWorkspaceDirectory(state, "src"),
      loadSessionWorkspaceDirectory(state, "src/nested"),
    ]);
    props.onSetFilter("all");
    expect(listFiles).toHaveBeenCalledTimes(3);
  });

  it("shares Outputs and Files artifact demand without loading a tree for Outputs", async () => {
    const { state, listFiles } = await fixture({ loadInitialListing: false });
    const response = createDeferred<{
      artifacts: NonNullable<SessionWorkspaceListResult["artifacts"]>;
    }>();
    const request = vi.fn(() => response.promise);
    state.client = createGatewayBrowserClientFixture({ request });
    const release = retainSessionWorkspaceArtifacts(state);
    const joined = loadSessionWorkspaceArtifacts(state);
    expect(listFiles).not.toHaveBeenCalled();
    createSessionWorkspaceProps(state, { expanded: true });
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve({
      artifacts: [
        { id: "assistant-result", title: "report.md", type: "file", download: { mode: "bytes" } },
      ],
    });
    await joined;
    await vi.waitFor(() => expect(getSessionWorkspace(state).loading).toBe(false));
    expect(getSessionWorkspace(state).artifacts?.items[0]?.id).toBe("assistant-result");
    expect(getSessionWorkspace(state).list?.artifacts?.[0]?.id).toBe("assistant-result");
    refreshSessionWorkspaceState(state, false);
    await loadSessionWorkspaceArtifacts(state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(listFiles).toHaveBeenCalledTimes(1);
    release();
  });

  it("keeps artifact results scoped when the session changes during a request", async () => {
    const { state } = await fixture({ loadInitialListing: false });
    const oldResponse = createDeferred<{
      artifacts: NonNullable<SessionWorkspaceListResult["artifacts"]>;
    }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValue({ artifacts: [] });
    state.client = createGatewayBrowserClientFixture({ request });
    const old = loadSessionWorkspaceArtifacts(state);
    state.sessionKey = "agent:main:other";
    await loadSessionWorkspaceArtifacts(state);
    oldResponse.resolve({
      artifacts: [
        { id: "old-file", title: "private.md", type: "file", download: { mode: "bytes" } },
      ],
    });
    await old;
    expect(getSessionWorkspace(state).artifacts?.items).toEqual([]);
    expect(getSessionWorkspace(state).sessionKey).toBe("agent:main:other");
  });

  it("loads only expanded directories and shares concurrent demand for the same directory", async () => {
    const { state } = await fixture({ loadInitialListing: false });
    const response = createDeferred<SessionWorkspaceListResult>();
    const listFiles = vi.fn(() => response.promise);
    state.sessions = createSessionCapabilityFixture({ listFiles });
    const first = loadSessionWorkspaceDirectory(state, "docs");
    const second = loadSessionWorkspaceDirectory(state, "docs");
    expect(listFiles).toHaveBeenCalledTimes(1);
    response.resolve({
      sessionKey: state.sessionKey,
      files: [],
      browser: {
        path: "docs",
        entries: [
          { path: "docs/guides", name: "guides", kind: "directory" },
          { path: "docs/readme.md", name: "readme.md", kind: "file" },
        ],
      },
    });
    await Promise.all([first, second]);
    await loadSessionWorkspaceDirectory(state, "docs");
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(Object.keys(getSessionWorkspace(state).directories ?? {})).toEqual(["docs"]);
    expect(
      getSessionWorkspace(state).directories?.docs?.browser?.entries.map((entry) => entry.path),
    ).toEqual(["docs/guides", "docs/readme.md"]);
  });
});

it("keeps project, external and artifact homonyms distinct while search ignores activity", () => {
  const listing: SessionWorkspaceListResult = {
    sessionKey: "agent:main:catalog",
    root: "/workspace",
    files: [
      {
        path: "report.md",
        workspacePath: "docs/report.md",
        name: "report.md",
        kind: "read",
        missing: false,
      },
      {
        path: "/outside/report.md",
        workspacePath: "/outside/report.md",
        name: "report.md",
        kind: "modified",
        missing: false,
      },
    ],
    artifacts: [{ id: "opaque-id", title: "report.md", type: "file", download: { mode: "bytes" } }],
    browser: { path: "", entries: [{ path: "docs", name: "docs", kind: "directory" }] },
  };
  const catalog = projectWorkspaceCatalog(listing);
  expect(catalog.session.map((file) => file.artifactId ?? file.path)).toEqual([
    "/outside/report.md",
    "opaque-id",
  ]);
  expect(
    workspaceCatalogChildren(catalog, "read")
      .get("")
      ?.map((file) => file.name),
  ).toEqual(["docs"]);
  expect(
    workspaceCatalogChildren(catalog, "read")
      .get("docs")
      ?.map((file) => file.name),
  ).toEqual(["report.md"]);
  const results = workspaceCatalogSearch(listing, "report");
  expect(results).toHaveLength(3);
  expect(new Set(results.map((file) => file.key)).size).toBe(3);
  expect(workspaceCatalogSearch(listing, "opaque-id")).toEqual([]);
  expect(workspaceCatalogSearch(listing, "")).toEqual([]);
});

it.each([
  ["types.d.ts", "types", ".d.ts"],
  ["backup.tar.gz", "backup", ".tar.gz"],
  [".gitignore", ".gitignore", ""],
])("keeps the complete suffix of %s", (name, stem, extension) => {
  expect(splitWorkspaceFilename(name)).toEqual({ stem, extension });
});

it.each([false, true])(
  "unions activity for canonical aliases regardless of order (reverse: %s)",
  (reverse) => {
    const files: SessionWorkspaceListResult["files"] = [
      {
        path: "report.md",
        workspacePath: "docs/report.md",
        name: "report.md",
        kind: "modified",
        missing: false,
      },
      {
        path: "../docs/report.md",
        workspacePath: "docs/report.md",
        name: "report.md",
        kind: "read",
        missing: false,
      },
    ];
    const listing: SessionWorkspaceListResult = {
      sessionKey: "agent:main:aliases",
      root: "/workspace",
      files: reverse ? files.toReversed() : files,
    };
    const catalog = projectWorkspaceCatalog(listing);
    expect(catalog.project.get("docs/report.md")?.activity).toBe("mixed");
    expect(catalog.filters).toEqual(["all", "changed", "read"]);
    for (const filter of ["changed", "read"] as const) {
      expect(
        [...workspaceCatalogChildren(catalog, filter).values()]
          .flat()
          .filter((row) => !row.directory),
      ).toHaveLength(1);
    }
    expect(workspaceCatalogSearch(listing, "report")).toMatchObject([
      { activity: "mixed", workspacePath: "docs/report.md" },
    ]);
  },
);

it("keeps unresolved session paths separate from authoritative project paths", () => {
  const listing: SessionWorkspaceListResult = {
    sessionKey: "agent:main:paths",
    root: "/workspace",
    files: [
      { path: "docs/report.md", name: "report.md", kind: "modified", missing: true },
      {
        path: "../docs/report.md",
        workspacePath: "docs/report.md",
        name: "report.md",
        kind: "read",
        missing: false,
      },
    ],
    browser: {
      path: "docs",
      entries: [{ path: "docs/report.md", name: "report.md", kind: "file" }],
    },
  };
  const catalog = projectWorkspaceCatalog(listing);
  expect(catalog.session).toMatchObject([
    { key: "file:docs/report.md", path: "docs/report.md", origin: "session", activity: "modified" },
  ]);
  expect(catalog.project.get("docs/report.md")?.activity).toBe("read");
  expect(catalog.session[0]?.key).not.toBe(catalog.project.get("docs/report.md")?.key);
  expect([...workspaceCatalogChildren(catalog, "changed").values()].flat()).toEqual([]);
  const results = workspaceCatalogSearch(listing, "report");
  expect(results).toHaveLength(2);
  expect(new Set(results.map((file) => file.key)).size).toBe(2);
});

it("offers folder filters only for project files inside that path boundary", () => {
  const catalog = projectWorkspaceCatalog({
    sessionKey: "agent:main:folder-filters",
    root: "/workspace",
    files: [
      {
        path: "ui/change.ts",
        workspacePath: "ui/change.ts",
        name: "change.ts",
        kind: "modified",
        missing: false,
      },
      {
        path: "ui-other/read.md",
        workspacePath: "ui-other/read.md",
        name: "read.md",
        kind: "read",
        missing: false,
      },
      { path: "/outside/notes.md", name: "notes.md", kind: "read", missing: false },
    ],
    artifacts: [{ id: "report", title: "report.md", type: "file", download: { mode: "bytes" } }],
  });
  expect(catalog.filters).toEqual(["all", "changed", "read", "artifacts"]);
  expect(workspaceCatalogFilters(catalog, "")).toEqual(["all", "changed", "read"]);
  expect(workspaceCatalogFilters(catalog, "ui")).toEqual(["all", "changed"]);
  expect(workspaceCatalogFilters(catalog, "ui-other")).toEqual(["all", "read"]);
  expect(workspaceCatalogFilters(catalog, "empty")).toEqual(["all"]);
});
