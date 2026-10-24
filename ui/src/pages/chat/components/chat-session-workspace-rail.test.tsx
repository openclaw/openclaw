/* @vitest-environment jsdom */

import { createSignal, flush, onSettled } from "solid-js";
import { afterEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
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
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

type List = NonNullable<SessionWorkspaceProps["list"]>;
type WorkspaceFixture = Omit<Partial<SessionWorkspaceProps>, "list"> & {
  list?: Omit<List, "sessionKey">;
};

function createWorkspace(overrides: WorkspaceFixture = {}): SessionWorkspaceProps {
  return {
    sessionKey: "agent:main:workspace",
    loading: false,
    readResult: overrides.loading ? new Promise<void>(() => {}) : undefined,
    error: null,
    activeId: null,
    filter: "all",
    browserPath: "",
    browserSearch: "",
    onBrowsePath: vi.fn(),
    onRetry: vi.fn(),
    onOpenFile: vi.fn(),
    onSearch: vi.fn(),
    onSetFilter: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
    list: overrides.list ? { sessionKey: "agent:main:workspace", ...overrides.list } : null,
  };
}

async function mountWorkspace(workspace: SessionWorkspaceProps) {
  const [current, setCurrent] = createSignal(workspace);
  const view = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
  if (!workspace.loading) {
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    flush();
  }
  return {
    ...view,
    update(this: void, next: SessionWorkspaceProps = workspace) {
      setCurrent({ ...next });
      flush();
    },
  };
}

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

type WorkspaceFile = NonNullable<SessionWorkspaceProps["list"]>["files"][number];
function file(path: string, kind: WorkspaceFile["kind"] = "modified"): WorkspaceFile {
  return { path, name: path.split(/[\\/]/).at(-1)!, kind, missing: false };
}

function artifact(id: string, title: string) {
  return { id, title, type: "file", download: { mode: "bytes" as const } };
}

function fileNames(mount: ParentNode) {
  return Array.from(
    mount.querySelectorAll(".chat-workspace-rail__file-name"),
    (row) => row.textContent,
  );
}

function button(mount: ParentNode, label: string) {
  return mount.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function searchInput(mount: ParentNode) {
  return mount.querySelector<HTMLInputElement>('input[type="search"]')!;
}

function search(mount: ParentNode, value: string) {
  const input = searchInput(mount);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps Files search usable during a failed owner read and retries without duplicate requests", async () => {
  setupDesktopLayout();
  const first = createDeferred<List>();
  const retry = createDeferred<List>();
  const listFiles = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  const state: SessionWorkspaceHost = {
    sessionKey: "agent:main:workspace",
    connected: true,
    connectionEpoch: 1,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    sidebarContent: null,
    handleOpenSidebar: () => {},
  };
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: true, presentation: "desktop" });
  const [current, setCurrent] = createSignal(props());
  const mounted = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
  const stop = sessionWorkspaceForHost(state).subscribe(() => setCurrent(props()));
  onTestFinished(() => {
    stop();
    mounted.unmount();
  });
  expect(button(mounted.container, "Search files")).not.toBeNull();
  expect(mounted.container.querySelector("[aria-busy=true]")).not.toBeNull();
  first.reject(new Error("Files unavailable; retry"));
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Files unavailable; retry"),
  );
  mounted.getByRole("button", { name: "Retry" }).click();
  expect(listFiles).toHaveBeenCalledTimes(2);
  retry.resolve({
    sessionKey: state.sessionKey,
    root: "/synthetic/workspace",
    files: [],
    browser: { path: "", entries: [{ path: "notes.md", name: "notes.md", kind: "file" }] },
  });
  await waitForSolid(() => expect(button(mounted.container, "notes.md")).not.toBeNull());
  expect(mounted.queryByRole("alert")).toBeNull();
  expect(listFiles).toHaveBeenCalledTimes(2);
});

it.each(["desktop", undefined] as const)(
  "keeps available files usable after a %s refresh fails",
  async (presentation) => {
    const onOpenFile = vi.fn();
    const workspace = createWorkspace({
      presentation,
      onOpenFile,
      list: {
        root: "/synthetic/workspace",
        files: [file("notes.md")],
        browser: { path: "", entries: [] },
      },
    });
    const mounted = await mountWorkspace(workspace);
    onTestFinished(mounted.unmount);
    const row = mounted.getByRole("button", { name: /^notes\.md$/ });
    const disclosure = row.closest("details");
    if (!presentation) {
      expect(disclosure).not.toBeNull();
    }
    disclosure?.querySelector("summary")?.click();
    const expanded = disclosure?.open;
    for (const error of ["Artifacts unavailable", "Workspace refresh unavailable"]) {
      mounted.update({ ...workspace, error });
      await waitForSolid(() => expect(mounted.getByRole("alert").textContent).toBe(error));
      expect(mounted.getByRole("button", { name: /^notes\.md$/ })).toBe(row);
      expect(disclosure?.open).toBe(expanded);
      mounted.getByRole("button", { name: /^notes\.md$/ }).click();
      expect(onOpenFile).toHaveBeenLastCalledWith(
        "notes.md",
        "session",
        ...(presentation ? ["preview"] : []),
      );
      mounted.update(workspace);
      await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
      expect(mounted.getByRole("button", { name: /^notes\.md$/ })).toBe(row);
      expect(disclosure?.open).toBe(expanded);
    }
  },
);

it.each(["desktop", undefined] as const)(
  "shows loading when a ready %s workspace changes to a pending session",
  async (presentation) => {
    setupDesktopLayout();
    const mounted = await mountWorkspace(
      createWorkspace({
        presentation,
        list: { root: "/synthetic/workspace", files: [file("old.md")] },
      }),
    );
    onTestFinished(mounted.unmount);
    expect(mounted.container.textContent).toContain("old.md");
    mounted.update(
      createWorkspace({ presentation, sessionKey: "agent:main:other", loading: true }),
    );
    await waitForSolid(() =>
      expect(mounted.container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull(),
    );
    expect(mounted.container.textContent).not.toContain("old.md");
  },
);

describe("session workspace path actions", () => {
  it.each([
    ["reports/monthly", false, "reports"],
    ["reports", true, null],
  ] as const)(
    "keeps folder recovery available for %s (loading: %s)",
    async (path, loading, parentPath) => {
      const onBrowsePath = vi.fn();
      const workspace = createWorkspace({
        browserPath: path,
        loading,
        list: { files: [], root: "/workspace" },
        onBrowsePath,
      });
      const { container: mount } = await mountWorkspace(workspace);
      const parent = button(mount, "..");
      if (parentPath === null) {
        expect(parent).toBeNull();
        expect(mount.textContent).not.toContain("This folder is unavailable.");
      } else {
        expect(parent).not.toBeNull();
        expect(mount.textContent).toContain("This folder is unavailable.");
        parent!.click();
        expect(onBrowsePath).toHaveBeenCalledExactlyOnceWith(parentPath);
      }
    },
  );

  it("retains selection and action focus after reads and refreshes", async () => {
    clipboard();
    const entry = file("README.md");
    const result = { sessionKey: "agent:main:current", root: "/workspace", files: [entry] };
    const fileRequested = createDeferred();
    const fileRead = createDeferred();
    onTestFinished(() => fileRead.resolve());
    const state = {
      client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
      connected: true,
      handleOpenSidebar: vi.fn(),
      hello: null,
      agentsList: [],
      sessionKey: result.sessionKey,
      sidebarContent: null,
      sessions: {
        listFiles: vi.fn().mockResolvedValue(result),
        getFile: vi.fn(async () => {
          fileRequested.resolve();
          await fileRead.promise;
          return {
            ...result,
            file: { ...entry, previewKind: "text", contentEncoding: "utf8", content: "# Readme" },
          };
        }),
      },
    } as unknown as SessionWorkspaceHost;
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    const { container, update } = await mountWorkspace(
      createSessionWorkspaceProps(state, { expanded: true }),
    );
    const renderRows = () => update(createSessionWorkspaceProps(state, { expanded: true }));
    renderRows();
    const preview = button(container, "Preview");
    assert(preview);
    preview.focus();
    preview.click();
    const opened = state.sessionWorkspaceState?.previews[0];
    assert(opened?.readResult);
    await fileRequested.promise;
    expect(opened.content.kind).toBe("loading");
    fileRead.resolve();
    // This receipt includes the lazy content import, file read, and current-preview publication.
    await opened.readResult;
    expect(state.sessionWorkspaceState?.previews[0]).toBe(opened);
    expect(opened.content.kind).toBe("file");
    expect(state.sessions.getFile).toHaveBeenCalledOnce();
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(preview);
    const copy = button(container, "Copy path");
    assert(copy);
    copy.focus();
    copy.click();
    await vi.waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copied!"));
    loadSessionWorkspace(state, getSessionWorkspace(state), true);
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(copy);
    expect(container.querySelector('button[aria-label="Copied!"]')).toBe(copy);
    expect(copy.parentElement?.querySelector('[role="status"]')?.textContent).toBe("Copied!");
  });

  it("keeps Windows file labels readable and distinct", async () => {
    const root = "C:\\synthetic\\very-long-workspace-prefix";
    const separator = "\\";
    const path = (...parts: string[]) => [root, ...parts].join(separator);
    const paths = [path("inventory.csv"), path("ui", "index.ts"), path("api", "index.ts")];
    const writeText = clipboard();
    const onOpenFile = vi.fn();
    const files = paths.map((filePath, index) => file(filePath, index === 2 ? "read" : "modified"));
    const workspace = createWorkspace({
      list: { files, root },
      activeId: `file:${paths[1]}`,
      onOpenFile,
    });
    const { container: mount, update } = await mountWorkspace(workspace);
    update(workspace);
    expect(fileNames(mount)).toEqual([
      "inventory.csv",
      `ui${separator}index.ts`,
      `api${separator}index.ts`,
    ]);
    const rows = [...mount.querySelectorAll(".chat-workspace-rail__file")];
    for (const [index, row] of rows.entries()) {
      const open = row.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!;
      expect(open.getAttribute("aria-label")).toBe(paths[index]);
      expect(row.querySelector("openclaw-tooltip")?.content).toBe(paths[index]);
      open.click();
      expect(onOpenFile).toHaveBeenLastCalledWith(paths[index], "session");
      button(row, "Copy path")!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(paths[index]));
    }
    const selectedRow = rows[1];
    assert(selectedRow, "Expected the selected ui/index.ts row");
    expect(selectedRow.classList.contains("chat-workspace-rail__file--active")).toBe(true);
    workspace.filter = "changed";
    update(workspace);
    expect(fileNames(mount)).toEqual(["inventory.csv", `ui${separator}index.ts`]);
    workspace.browserSearch = `ui${separator}index`;
    update(workspace);
    expect(fileNames(mount)).toEqual([`ui${separator}index.ts`]);
  });

  it("shows Copy failed when copying a session Files path", async () => {
    const writeText = clipboard(
      vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError")),
    );
    const onOpenFile = vi.fn();
    const workspace = createWorkspace({
      list: {
        files: [file("src/edited.ts")],
        root: "/synthetic/project",
        browser: {
          path: "",
          entries: [{ kind: "file", name: "browser.ts", path: "src/browser.ts" }],
        },
      },
      onOpenFile,
    });
    const { container: mount } = await mountWorkspace(workspace);

    const row = mount.querySelector<HTMLElement>(
      ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file",
    );
    expect(row).toBeInstanceOf(HTMLElement);
    const rowClick = vi.fn();
    row!.addEventListener("click", rowClick);
    const copy = button(row!, "Copy path");
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    copy!.click();
    await vi.waitFor(() => expect(copy!.getAttribute("aria-label")).toBe("Copy failed"));

    expect(writeText).toHaveBeenCalledWith("src/edited.ts");
    const feedback = copy!.parentElement?.querySelector<HTMLElement>('[role="status"]');
    expect(feedback).toMatchObject({ textContent: "Copy failed", hidden: false });
    expect(rowClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();

    const preview = button(row!, "Preview");
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview!.click();
    expect(onOpenFile).toHaveBeenCalledWith("src/edited.ts", "session");
  });

  it("retains disclosure state and expands search matches", async () => {
    const workspace = createWorkspace({
      list: {
        files: [file("src/edited.ts")],
        artifacts: [
          {
            ...artifact("portrait-1", "Portrait"),
            mimeType: "image/jpeg",
            type: "image",
            sizeBytes: 2048,
          },
        ],
      },
    });
    const { container: mount, update } = await mountWorkspace(workspace);
    const [changed, artifacts] = mount.querySelectorAll("details");
    assert(changed && artifacts, "Expected Changed and Artifacts disclosures");
    expect([changed.open, artifacts.open]).toEqual([true, false]);
    changed.querySelector("summary")!.click();
    artifacts.querySelector("summary")!.click();

    update({ ...workspace, activeId: "artifact:portrait-1" });

    expect([changed.open, artifacts.open]).toEqual([false, true]);
    artifacts.querySelector("summary")!.click();
    workspace.browserSearch = "IMAGE";
    update(workspace);

    expect(mount.querySelectorAll(".chat-workspace-rail__group")).toHaveLength(1);
    expect(mount.querySelector("summary")?.textContent).toContain("Artifacts");
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.textContent).toContain("Portrait");
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).toBeNull();
    expect(searchInput(mount).value).toBe("IMAGE");

    workspace.browserSearch = "";
    update(workspace);
    mount.querySelector("summary")!.click();
    expect(mount.querySelector("details")?.open).toBe(false);
    update({ ...workspace, filter: "changed" });

    expect(mount.querySelectorAll("details")).toHaveLength(1);
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).not.toBeNull();
  });

  it.each([
    ["changed", true, 1],
    ["read", true, 1],
    ["artifacts", true, 1],
    ["all", true, 3],
    ["all", false, 3],
  ] as const)("recovers empty %s searches (browser: %s)", async (filter, browser, restored) => {
    const workspace = createWorkspace({
      list: {
        files: [file("report.csv"), file("report.md", "read")],
        artifacts: [artifact("report", "Report")],
        ...(browser ? { browser: { path: "", entries: [] } } : {}),
      },
    });
    const { container: mount, update } = await mountWorkspace(workspace);
    workspace.onSearch = (query) => {
      workspace.browserSearch = query;
      if (workspace.list?.browser) {
        workspace.list.browser.search = query;
      }
      update();
    };
    workspace.onSetFilter = (value) => {
      workspace.filter = value;
      update();
    };
    update();
    search(mount, "NO-SUCH-FILE");
    const label = filter === "all" ? "All" : `1 ${filter}`;
    const chip = [...mount.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    assert(chip, "Expected the selected Files filter to remain available");
    chip.click();
    expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(0);
    expect(mount.textContent?.match(/No matching files\./g)).toHaveLength(1);
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    search(mount, "");
    expect(fileNames(mount)).toHaveLength(restored);
    expect(mount.textContent).not.toContain("No matching files.");
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    search(mount, "NO-SUCH-FILE");
    workspace.list = null;
    for (const state of [
      { loading: true, error: null },
      { loading: false, error: null },
      { loading: false, error: "Files could not be loaded." },
    ]) {
      Object.assign(workspace, state);
      update();
      expect(mount.textContent).not.toContain("No matching files.");
    }
    await waitForSolid(() => expect(mount.textContent).toContain(workspace.error));
  });

  it("matches every Files group without collapsing internal spaces", async () => {
    const query = "  A  B  ";
    const workspace = createWorkspace({
      browserSearch: query,
      list: {
        files: [file("a  b.csv"), file("a  b.md", "read"), file("a b.csv")],
        artifacts: [artifact("report", "A  b"), artifact("other", "A b")],
        browser: {
          path: "",
          search: "a  b",
          entries: [{ kind: "file", name: "a  b.csv", path: "a  b.csv" }],
        },
      },
    });
    const { container: mount, update } = await mountWorkspace(workspace);
    expect(fileNames(mount)).toEqual(["a  b.csv", "a  b.md", "A  b", "a  b.csv"]);
    expect(searchInput(mount).value).toBe(query);

    update({ ...workspace, browserSearch: "   " });
    expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(6);
  });
});

function setupDesktopLayout() {
  // JSDOM has no layout observation or font loading. These tests exercise the
  // workspace owner; real-browser proof owns overflow and disclosure motion.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
  onTestFinished(() => {
    if (previousFonts) {
      Object.defineProperty(document, "fonts", previousFonts);
    } else {
      Reflect.deleteProperty(document, "fonts");
    }
  });
}

it("desktop browses lazy directories and restores activity after global search closes", async () => {
  setupDesktopLayout();
  const listFiles = vi.fn(
    async (_sessionKey: string, options?: { path?: string; search?: string }) => ({
      sessionKey: "agent:main:workspace",
      root: "/workspace",
      files: [
        { ...file("changed.ts"), workspacePath: "src/changed.ts" },
        { ...file("read.md", "read"), workspacePath: "docs/read.md" },
        { ...file("/outside/notes.md", "read"), workspacePath: "/outside/notes.md" },
      ],
      browser: {
        path: options?.path ?? "",
        truncated: options?.path === "docs",
        ...(options?.search ? { search: options.search } : {}),
        entries: options?.search
          ? [{ path: "docs/read.md", name: "read.md", kind: "file" as const }]
          : options?.path === "docs"
            ? [{ path: "docs/untouched.md", name: "untouched.md", kind: "file" as const }]
            : [
                { path: "docs", name: "docs", kind: "directory" as const },
                { path: "src", name: "src", kind: "directory" as const },
              ],
      },
    }),
  );
  const state: SessionWorkspaceHost = {
    sessionKey: "agent:main:workspace",
    connected: true,
    connectionEpoch: 1,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    sidebarContent: null,
    handleOpenSidebar: () => {},
  };
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: true, presentation: "desktop" });
  const mounted = await mountWorkspace(props());
  const unsubscribe = sessionWorkspaceForHost(state).subscribe(() => mounted.update(props()));
  try {
    await vi.waitFor(() => expect(button(mounted.container, "docs")).not.toBeNull());
    button(mounted.container, "docs")!.click();
    await vi.waitFor(() => expect(button(mounted.container, "docs/untouched.md")).not.toBeNull());
    expect(listFiles.mock.calls.map(([, options]) => options?.path)).toEqual(["", "docs"]);
    expect(mounted.container.textContent).toContain(
      "Showing the first matching files. Refine the search to narrow results.",
    );
    props().onSetFilter("changed");
    flush();
    button(mounted.container, "Search files")!.click();
    flush();
    search(mounted.container, "read");
    await vi.waitFor(() =>
      expect(mounted.container.querySelector(".workspace-desktop__results")?.textContent).toContain(
        "read.md",
      ),
    );
    expect(getSessionWorkspace(state).filter).toBe("changed");
    button(mounted.container, "Close file search")!.click();
    flush();
    expect(getSessionWorkspace(state).browserSearch).toBe("");
    expect(getSessionWorkspace(state).tree?.searchOpen).toBe(false);
    expect(getSessionWorkspace(state).tree?.expandedPaths).toContain("docs");
    expect(getSessionWorkspace(state).filter).toBe("changed");
  } finally {
    unsubscribe();
    mounted.unmount();
  }
});

it("desktop distinguishes incomplete matching searches from empty complete results", async () => {
  setupDesktopLayout();
  const warning = "Showing the first matching files. Refine the search to narrow results.";
  const navigation = {
    browserPath: "",
    browserSearch: "",
    filter: "all" as const,
    expandedPaths: ["", "docs"],
    searchOpen: false,
    sessionExpanded: true,
    treeVisible: true,
    treeScroll: 0,
    sessionScroll: 0,
  };
  const workspace = createWorkspace({
    presentation: "desktop",
    navigation,
    list: {
      root: "/workspace",
      files: [],
      browser: { path: "", search: "report", entries: [], truncated: true },
    },
    directories: {
      "": {
        loading: false,
        error: null,
        browser: {
          path: "",
          entries: [{ path: "docs", name: "docs", kind: "directory" }],
          truncated: true,
        },
      },
      docs: {
        loading: false,
        error: null,
        browser: { path: "docs", entries: [], truncated: true },
      },
    },
  });
  const mounted = await mountWorkspace(workspace);
  try {
    expect(
      [
        ...mounted.container.querySelectorAll(".workspace-desktop__project-scroll [role=status]"),
      ].filter((node) => node.textContent === warning),
    ).toHaveLength(2);
    mounted.update({
      ...workspace,
      browserSearch: "different",
      navigation: { ...navigation, searchOpen: true },
    });
    expect(
      mounted.container.querySelector(".workspace-desktop__results")?.textContent,
    ).not.toContain(warning);
    mounted.update({
      ...workspace,
      browserSearch: "report",
      navigation: { ...navigation, searchOpen: true },
    });
    const results = () =>
      mounted.container.querySelector(".workspace-desktop__results")?.textContent;
    expect(results()).toContain(warning);
    expect(results()).not.toContain("No matching files.");
    mounted.update({
      ...workspace,
      browserSearch: "report",
      navigation: { ...navigation, searchOpen: true },
      list: {
        ...workspace.list!,
        browser: { path: "", search: "report", entries: [] },
      },
    });
    expect(results()).not.toContain(warning);
    expect(results()).toContain("No matching files.");
  } finally {
    mounted.unmount();
  }
});

it("desktop folder falls back from a saved session-only filter without mutating it", async () => {
  setupDesktopLayout();
  const workspace = createWorkspace({
    presentation: "desktop",
    folderView: true,
    filter: "artifacts",
    list: {
      root: "/workspace",
      files: [],
      artifacts: [artifact("report", "report.md")],
      browser: {
        path: "",
        entries: [{ path: "README.md", name: "README.md", kind: "file" }],
      },
    },
  });
  const mounted = await mountWorkspace(workspace);
  try {
    expect(button(mounted.container, "README.md")).not.toBeNull();
    expect(button(mounted.container, "report.md")).toBeNull();
    expect(workspace.filter).toBe("artifacts");
    expect(workspace.onSetFilter).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
  }
});

it("mobile restores folder search and root groups without mixing global search results", async () => {
  setupDesktopLayout();
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const listFiles = vi.fn(async (_key: string, options?: { path?: string; search?: string }) => ({
    sessionKey: "agent:main:workspace",
    root: "/workspace",
    files: [file("notes.md", "read")],
    browser: {
      path: options?.path ?? "",
      ...(options?.search ? { search: options.search } : {}),
      entries: options?.search
        ? [
            { path: "docs/report.txt", name: "report.txt", kind: "file" as const, size: 1536 },
            { path: "outside/report.txt", name: "report.txt", kind: "file" as const },
          ]
        : options?.path === "docs"
          ? [{ path: "docs/report.txt", name: "report.txt", kind: "file" as const, size: 1536 }]
          : [{ path: "docs", name: "docs", kind: "directory" as const }],
    },
  }));
  const state: SessionWorkspaceHost = {
    sessionKey: "agent:main:workspace",
    connected: true,
    connectionEpoch: 1,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    sidebarContent: null,
    handleOpenSidebar: () => {},
  };
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: true, presentation: "mobile" });
  const mounted = await mountWorkspace(props());
  const unsubscribe = sessionWorkspaceForHost(state).subscribe(() => mounted.update(props()));
  onTestFinished(() => {
    unsubscribe();
    mounted.unmount();
  });
  const ready = () =>
    waitForSolid(() => {
      expect(mounted.container.querySelector('[aria-busy="false"]')).not.toBeNull();
    });
  await ready();
  expect(button(mounted.container, "notes.md")).toBeNull();
  const readGroup = [
    ...mounted.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ].find((entry) => entry.textContent?.includes("Read"));
  assert(readGroup);
  readGroup.click();
  flush();
  expect(button(mounted.container, "notes.md")).not.toBeNull();
  readGroup.click();
  flush();
  expect(button(mounted.container, "notes.md")).toBeNull();
  const scroll = mounted.container.querySelector<HTMLElement>(".chat-workspace-mobile__scroll")!;
  scroll.scrollTop = 37;
  scroll.dispatchEvent(new Event("scroll"));
  button(mounted.container, "docs")!.click();
  await ready();
  expect(button(mounted.container, "notes.md")).toBeNull();
  expect(mounted.container.textContent).toContain("1.5 KB");
  search(mounted.container, "report");
  await vi.advanceTimersByTimeAsync(160);
  await ready();
  expect(button(mounted.container, "docs/report.txt")).not.toBeNull();
  expect(button(mounted.container, "outside/report.txt")).toBeNull();
  button(mounted.container, "Parent folder")!.click();
  await ready();
  expect(searchInput(mounted.container).value).toBe("");
  expect(button(mounted.container, "notes.md")).toBeNull();
  expect(scroll.scrollTop).toBe(37);
  button(mounted.container, "docs")!.click();
  await ready();
  expect(searchInput(mounted.container).value).toBe("report");
  expect(button(mounted.container, "docs/report.txt")).not.toBeNull();
  expect(button(mounted.container, "outside/report.txt")).toBeNull();
});
