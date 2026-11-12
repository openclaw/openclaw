/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { readChatTranscriptAttachmentSource } from "../chat-history-state.ts";
import { createState } from "../chat-history.inflight.test-support.ts";
import { loadChatHistory } from "../chat-history.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
import { createSessionWorkspaceHost } from "./chat-session-workspace-host.test-support.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import {
  createWorkspace,
  file,
  mountWorkspace,
  setupDesktopLayout,
} from "./chat-session-workspace-rail.test-support.ts";
import {
  captureSessionWorkspaceNavigation,
  getSessionWorkspace,
  loadSessionWorkspace,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type {
  TranscriptAttachmentEntry,
  TranscriptAttachments,
} from "./chat-sidebar-content-types.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import { projectTranscriptAttachments } from "./chat-transcript-attachments.ts";

type List = NonNullable<SessionWorkspaceProps["list"]>;

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

function artifact(id: string, title: string) {
  return { id, title, type: "file", download: { mode: "bytes" as const } };
}

function fileNames(mount: ParentNode) {
  return Array.from(
    mount.querySelectorAll(".workspace-desktop__filename"),
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

beforeEach(setupDesktopLayout);

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["desktop", "mobile", undefined] as const)(
  "keeps %s Files search usable during a failed owner read and retries without duplicate requests",
  async (presentation) => {
    const first = createDeferred<List>();
    const retry = createDeferred<List>();
    const listFiles = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const state: SessionWorkspaceHost = createSessionWorkspaceHost({
      sessionKey: "agent:main:workspace",
      agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
      client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
      sessions: createSessionCapabilityFixture({ listFiles }),
      handleOpenSidebar: () => {},
    });
    const props = () => createSessionWorkspaceProps(state, { expanded: true, presentation });
    const [current, setCurrent] = createSignal(props());
    const mounted = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
    const stop = sessionWorkspaceForHost(state).subscribe(() => setCurrent(props()));
    onTestFinished(() => {
      stop();
      mounted.unmount();
    });
    expect(
      presentation === "desktop"
        ? button(mounted.container, "Search files")
        : searchInput(mounted.container),
    ).not.toBeNull();
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
  },
);

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
    for (const error of ["Artifacts unavailable", "Workspace refresh unavailable"]) {
      mounted.update({ ...workspace, error });
      await waitForSolid(() => expect(mounted.getByRole("alert").textContent).toBe(error));
      expect(mounted.getByRole("button", { name: /^notes\.md$/ })).toBe(row);
      mounted.getByRole("button", { name: /^notes\.md$/ }).click();
      expect(onOpenFile).toHaveBeenLastCalledWith(
        "notes.md",
        "session",
        presentation ? "preview" : undefined,
      );
      mounted.update(workspace);
      await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
      expect(mounted.getByRole("button", { name: /^notes\.md$/ })).toBe(row);
    }
  },
);

it.each(["desktop", "mobile", undefined] as const)(
  "shows loading when a ready %s workspace changes to a pending session",
  async (presentation) => {
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
    ["reports/monthly", false, "reports", undefined],
    ["reports", true, null, undefined],
    ["reports/monthly", true, null, { path: "", search: "report", entries: [] }],
  ] satisfies [string, boolean, string | null, List["browser"]][])(
    "keeps folder recovery available for %s (loading: %s)",
    async (path, loading, parentPath, browser) => {
      const onBrowsePath = vi.fn();
      const workspace = createWorkspace({
        browserPath: path,
        loading,
        list: { files: [], root: "/workspace", browser },
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
    expect(opened.pinned).toBe(true);
    expect(opened.catalogNavigation).toEqual(
      captureSessionWorkspaceNavigation(getSessionWorkspace(state)),
    );
    expect(opened.catalogVisible).toBeUndefined();
    expect(state.sessions.getFile).toHaveBeenCalledOnce();
    renderRows();
    expect(container.querySelector(".workspace-desktop__row.is-active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(preview);
    const copy = button(container, "Copy path");
    assert(copy);
    copy.focus();
    copy.click();
    await vi.waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copied"));
    loadSessionWorkspace(state, getSessionWorkspace(state), true);
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    renderRows();
    expect(container.querySelector(".workspace-desktop__row.is-active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(copy);
    expect(container.querySelector('button[aria-label="Copied"]')).toBe(copy);
    expect(copy.parentElement?.querySelector('[role="status"]')?.textContent).toBe("Copied");
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
    expect(fileNames(mount)).toEqual(["inventory.csv", "index.ts", "index.ts"]);
    const rows = [...mount.querySelectorAll(".workspace-desktop__item--actions")];
    for (const [index, row] of rows.entries()) {
      const open = row.querySelector<HTMLButtonElement>(".workspace-desktop__row")!;
      expect(open.getAttribute("aria-label")).toBe(paths[index]);
      expect(row.querySelector(".workspace-desktop__location")?.textContent).toBe(paths[index]);
      open.click();
      expect(onOpenFile).toHaveBeenLastCalledWith(paths[index], "session", undefined);
      button(row, "Copy path")!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(paths[index]));
    }
    const selectedRow = rows[1];
    assert(selectedRow, "Expected the selected ui/index.ts row");
    expect(selectedRow.querySelector("[aria-current=true]")).not.toBeNull();
    workspace.filter = "changed";
    update(workspace);
    expect(fileNames(mount)).toEqual(["inventory.csv", "index.ts"]);
    workspace.browserSearch = `ui${separator}index`;
    update(workspace);
    expect(fileNames(mount)).toEqual(["index.ts"]);
  });

  it("shows Couldn’t copy. Try again. when copying a session Files path", async () => {
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
      ".workspace-desktop__session .workspace-desktop__item",
    );
    expect(row).toBeInstanceOf(HTMLElement);
    const rowClick = vi.fn();
    row!.addEventListener("click", rowClick);
    const copy = button(row!, "Copy path");
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    copy!.click();
    await vi.waitFor(() =>
      expect(copy!.getAttribute("aria-label")).toBe("Couldn’t copy. Try again."),
    );

    expect(writeText).toHaveBeenCalledWith("src/edited.ts");
    const feedback = copy!.parentElement?.querySelector<HTMLElement>('[role="status"]');
    expect(feedback).toMatchObject({ textContent: "Couldn’t copy. Try again.", hidden: false });
    expect(rowClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();

    const preview = button(row!, "Preview");
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview!.click();
    expect(onOpenFile).toHaveBeenCalledWith("src/edited.ts", "session", undefined);
  });

  it("retains owner disclosure and searches catalog metadata without mounting duplicate rows", async () => {
    const workspace = createWorkspace({
      navigation: {
        browserPath: "",
        browserSearch: "",
        filter: "all",
        expandedPaths: [""],
        searchOpen: false,
        sessionExpanded: true,
        treeVisible: true,
        treeScroll: 0,
        sessionScroll: 0,
      },
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
    const mounted = await mountWorkspace(workspace);
    onTestFinished(mounted.unmount);
    workspace.onSessionExpandedChange = (expanded) => {
      workspace.navigation = { ...workspace.navigation!, sessionExpanded: expanded };
      mounted.update(workspace);
    };
    mounted.update(workspace);
    const group = mounted.getByRole("button", { name: "Session files" });
    group.click();
    expect(group.getAttribute("aria-expanded")).toBe("false");
    mounted.update({ ...workspace, activeId: "artifact:portrait-1" });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    for (const query of ["IMAGE", "portrait-1"]) {
      mounted.update({ ...workspace, browserSearch: query });
      expect(mounted.container.querySelectorAll(".workspace-desktop__row")).toHaveLength(1);
      expect(fileNames(mounted.container)).toEqual(["Portrait"]);
      expect(mounted.container.textContent).toContain("image/jpeg / 2 KB");
      expect(button(mounted.container, "src/edited.ts")).toBeNull();
      expect(searchInput(mounted.container).value).toBe(query);
    }
    mounted.update({
      ...workspace,
      browserSearch: "",
      navigation: { ...workspace.navigation!, searchOpen: true },
    });
    expect(
      mounted.getByRole("button", { name: "Session files" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      mounted.container.querySelector(".workspace-desktop__results")?.hasAttribute("hidden"),
    ).toBe(true);
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
    const label =
      filter === "artifacts"
        ? "Session files"
        : filter === "all"
          ? "All"
          : filter === "read"
            ? "Read"
            : "Changed";
    const trigger = button(mount, "Filter files: All");
    assert(trigger, "Expected the activity menu during a catalog search");
    trigger.click();
    flush();
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    assert(option, "Expected the selected Files filter to remain available");
    option.click();
    flush();
    expect(fileNames(mount)).toHaveLength(0);
    expect(mount.textContent?.match(/No files match your search\./g)).toHaveLength(1);
    expect(button(mount, `Filter files: ${label}`)).not.toBeNull();

    search(mount, "");
    expect(fileNames(mount)).toHaveLength(restored);
    expect(mount.textContent).not.toContain("No files match your search.");
    expect(button(mount, `Filter files: ${label}`)).not.toBeNull();

    search(mount, "NO-SUCH-FILE");
    workspace.list = null;
    for (const state of [
      { loading: true, error: null },
      { loading: false, error: null },
      { loading: false, error: "Files could not be loaded." },
    ]) {
      Object.assign(workspace, state);
      update();
      expect(mount.textContent).not.toContain("No files match your search.");
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
    expect(mount.querySelectorAll(".workspace-desktop__filename")).toHaveLength(6);
  });
});

it.each(["mobile", undefined] as const)(
  "matches sigma forms in local Files groups (%s)",
  async (presentation) => {
    const path = "ΕΛΕΓΧΟΣ/A  B.md";
    const workspace = createWorkspace({
      presentation,
      list: {
        files: [file(path)],
        artifacts: [artifact("report", "ΕΛΕΓΧΟΣ")],
      },
      browserSearch: "Σ",
      mobileNavigation: {
        expandedGroups: { changed: true, read: true, artifacts: true, workspace: true },
        scrollTop: 0,
      },
    });
    const mounted = await mountWorkspace(workspace);
    for (const query of ["Σ", "σ", "ς", "  Σ  "]) {
      mounted.update({ ...workspace, browserSearch: query });
      await waitForSolid(() => expect(button(mounted.container, path)).not.toBeNull());
      expect(button(mounted.container, "ΕΛΕΓΧΟΣ")).not.toBeNull();
    }
    mounted.update({ ...workspace, browserSearch: "A  B.md" });
    expect(button(mounted.container, path)).not.toBeNull();
    mounted.update({ ...workspace, browserSearch: "A B.md" });
    expect(button(mounted.container, path)).toBeNull();
    mounted.unmount();
  },
);

it("desktop browses lazy directories and restores activity after an incomplete search", async () => {
  const incompleteNotice = "Search is incomplete. Some files may not appear in these results.";
  const directoryNotice =
    "Showing the first matching files. Refine your search to narrow the results.";
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
        truncated: options?.search !== "absent",
        ...(options?.search ? { search: options.search } : {}),
        entries: options?.search
          ? options.search === "read"
            ? [{ path: "docs/read.md", name: "read.md", kind: "file" as const }]
            : []
          : options?.path === "docs"
            ? [{ path: "docs/untouched.md", name: "untouched.md", kind: "file" as const }]
            : [
                { path: "docs", name: "docs", kind: "directory" as const },
                { path: "src", name: "src", kind: "directory" as const },
              ],
      },
    }),
  );
  const state: SessionWorkspaceHost = createSessionWorkspaceHost({
    sessionKey: "agent:main:workspace",
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    handleOpenSidebar: () => {},
  });
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: true, presentation: "desktop" });
  const mounted = await mountWorkspace(props());
  const unsubscribe = sessionWorkspaceForHost(state).subscribe(() => mounted.update(props()));
  try {
    await vi.waitFor(() => expect(button(mounted.container, "docs")).not.toBeNull());
    button(mounted.container, "docs")!.click();
    await vi.waitFor(() => expect(button(mounted.container, "docs/untouched.md")).not.toBeNull());
    expect(listFiles.mock.calls.map(([, options]) => options?.path)).toEqual(["", "docs"]);
    expect(
      [
        ...mounted.container.querySelectorAll(".workspace-desktop__project-scroll [role=status]"),
      ].filter((node) => node.textContent === directoryNotice),
    ).toHaveLength(2);
    const directory = getSessionWorkspace(state).directories!.docs!;
    directory.browser = {
      ...directory.browser!,
      entries: [{ path: "docs/refreshed.md", name: "refreshed.md", kind: "file" }],
    };
    sessionWorkspaceForHost(state).publish();
    await vi.waitFor(() => expect(button(mounted.container, "docs/refreshed.md")).not.toBeNull());
    expect(button(mounted.container, "docs/untouched.md")).toBeNull();
    directory.browser = {
      ...directory.browser,
      entries: [{ path: "docs/refreshed.md", name: "renamed.md", kind: "file" }],
    };
    sessionWorkspaceForHost(state).publish();
    await vi.waitFor(() =>
      expect(button(mounted.container, "docs/refreshed.md")?.textContent).toContain("renamed.md"),
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
    await vi.waitFor(() =>
      expect(mounted.queryByRole("button", { name: "Browse files" })).not.toBeNull(),
    );
    search(mounted.container, "different");
    flush();
    expect(
      mounted.container.querySelector(".workspace-desktop__results")?.textContent,
    ).not.toContain(incompleteNotice);
    search(mounted.container, "read");
    flush();
    mounted.getByRole("button", { name: "Browse files" }).click();
    flush();
    expect(getSessionWorkspace(state).browserSearch).toBe("");
    expect(getSessionWorkspace(state).tree?.searchOpen).toBe(false);
    expect(getSessionWorkspace(state).tree?.expandedPaths).toContain("docs");
    expect(getSessionWorkspace(state).filter).toBe("changed");
    await waitForSolid(() =>
      expect(document.activeElement).toBe(button(mounted.container, "Search files")),
    );
    for (const [query, incomplete] of [
      ["missing", true],
      ["absent", false],
    ] as const) {
      button(mounted.container, "Search files")!.click();
      flush();
      search(mounted.container, query);
      const results = () => mounted.container.querySelector(".workspace-desktop__results");
      await vi.waitFor(() => {
        expect(getSessionWorkspace(state).list?.browser?.search).toBe(query);
        expect(results()?.textContent).toContain(
          incomplete ? incompleteNotice : "No files match your search.",
        );
      });
      expect(Boolean(mounted.queryByRole("button", { name: "Browse files" }))).toBe(incomplete);
      if (incomplete) {
        expect(results()?.textContent).not.toContain("No files match your search.");
        mounted.getByRole("button", { name: "Browse files" }).click();
      } else {
        button(mounted.container, "Close file search")!.click();
      }
      flush();
      expect(getSessionWorkspace(state).browserSearch).toBe("");
    }
  } finally {
    unsubscribe();
    mounted.unmount();
  }
});

it("desktop folder falls back from a saved session-only filter without mutating it", async () => {
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
      truncated: Boolean(options?.search) && options?.search !== "absent",
      entries:
        options?.search === "docs/report.txt" || options?.search === "absent"
          ? []
          : options?.search
            ? [
                { path: "docs/report.txt", name: "report.txt", kind: "file" as const, size: 1536 },
                { path: "outside/report.txt", name: "report.txt", kind: "file" as const },
              ]
            : options?.path === "docs"
              ? [{ path: "docs/report.txt", name: "report.txt", kind: "file" as const, size: 1536 }]
              : [{ path: "docs", name: "docs", kind: "directory" as const }],
    },
  }));
  const state: SessionWorkspaceHost = createSessionWorkspaceHost({
    sessionKey: "agent:main:workspace",
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    handleOpenSidebar: () => {},
  });
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
  for (const query of ["report", "docs/report.txt"]) {
    search(mounted.container, query);
    await vi.advanceTimersByTimeAsync(160);
    await ready();
    expect(mounted.container.textContent).toContain(
      "Search is incomplete. Some files may not appear in these results.",
    );
    expect(mounted.container.textContent).not.toContain("No files match your search.");
    expect(Boolean(button(mounted.container, "docs/report.txt"))).toBe(query === "report");
    mounted.getByRole("button", { name: "Browse files" }).click();
    await ready();
    expect(searchInput(mounted.container).value).toBe("");
    expect(document.activeElement).toBe(searchInput(mounted.container));
    expect(getSessionWorkspace(state).browserPath).toBe("docs");
    expect(getSessionWorkspace(state).tree?.searchOpen).toBe(false);
    expect(button(mounted.container, "docs/report.txt")).not.toBeNull();
    expect(button(mounted.container, "outside/report.txt")).toBeNull();
    expect(mounted.queryByRole("button", { name: "Browse files" })).toBeNull();
  }
  search(mounted.container, "absent");
  await vi.advanceTimersByTimeAsync(160);
  await ready();
  expect(mounted.container.textContent).toContain("No files match your search.");
  expect(mounted.queryByRole("button", { name: "Browse files" })).toBeNull();
});

function transcriptAttachments(
  entries: TranscriptAttachmentEntry[],
  coverage: TranscriptAttachments["coverage"] = "complete",
): TranscriptAttachments {
  const source: TranscriptAttachments = {
    pairingQrExpirations: [],
    refresh: () => source,
    entries,
    coverage,
    loading: false,
    omittedMedia: false,
  };
  return source;
}

it.each(["desktop", "mobile"] as const)(
  "retains %s no-match presentation while accepted attachment history refreshes",
  async (presentation) => {
    const history = { messages: [], sessionId: "attachment-session" };
    const state = createState(history);
    await loadChatHistory(state);
    const attachments = () =>
      projectTranscriptAttachments(readChatTranscriptAttachmentSource(state), {}, () => {});
    const workspace = createWorkspace({
      presentation,
      browserSearch: "absent",
      navigation: {
        ...captureSessionWorkspaceNavigation(getSessionWorkspace(createSessionWorkspaceHost())),
        searchOpen: true,
        browserSearch: "absent",
      },
      list: { root: "/workspace", files: [], browser: { path: "", search: "absent", entries: [] } },
      transcriptAttachments: attachments(),
    });
    const mounted = await mountWorkspace(workspace);
    const empty = mounted.getByText("No files match your search.");
    const response = createDeferred<typeof history>();
    vi.spyOn(state.client!, "request").mockReturnValueOnce(response.promise);
    const pending = loadChatHistory(state);
    try {
      mounted.update({ ...workspace, transcriptAttachments: attachments() });
      expect(mounted.queryByText("Loading attachments…")).toBeNull();
      expect(mounted.getByText("No files match your search.")).toBe(empty);
    } finally {
      response.resolve(history);
      await pending;
      mounted.unmount();
    }
  },
);

function transcriptImage(label: string | undefined, key = label ?? "untitled") {
  return {
    kind: "image",
    key: `image:${key}`,
    label: label ?? "Image",
    mimeType: "image/png",
    image: { url: "data:image/png;base64,AA==", alt: label },
    options: {},
    onOpenSidebar: vi.fn(),
  } satisfies TranscriptAttachmentEntry;
}

it("desktop lists session files and transcript attachments together, sorted and tiled on request", async () => {
  const onSessionFilesDisplayChange = vi.fn();
  const workspace = createWorkspace({
    presentation: "desktop",
    list: {
      root: "/workspace",
      files: [file("/tmp/zeta.txt")],
      artifacts: [artifact("concept", "alpha.pdf")],
    },
    transcriptAttachments: transcriptAttachments(
      [transcriptImage(undefined), transcriptImage("beta.png")],
      "unknown",
    ),
    sessionFilesDisplay: { view: "list", sort: "default" },
    onSessionFilesDisplayChange,
  });
  const mounted = await mountWorkspace(workspace);
  try {
    const sessionList = () =>
      mounted.container.querySelector<HTMLElement>(".workspace-desktop__session-scroll")!;
    const labels = () =>
      Array.from(sessionList().querySelectorAll("[role=listitem] > button"), (row) =>
        row.getAttribute("aria-label"),
      );
    expect(labels()).toEqual(["/tmp/zeta.txt", "alpha.pdf", "Image", "beta.png"]);
    expect(sessionList().querySelector(".workspace-desktop__tile")).toBeNull();
    expect(mounted.getByRole("status").textContent).toContain("coverage is not yet known");

    mounted.update({ ...workspace, sessionFilesDisplay: { view: "grid", sort: "name" } });
    expect(sessionList().classList.contains("workspace-desktop__session-scroll--grid")).toBe(true);
    expect(labels()).toEqual(["alpha.pdf", "beta.png", "Image", "/tmp/zeta.txt"]);
    const tiles = sessionList().querySelectorAll<HTMLButtonElement>(".workspace-desktop__tile");
    expect(tiles).toHaveLength(4);
    // Inline image bytes render immediately; the untitled image shows pixels, not a generic caption.
    const untitled = tiles[2]!;
    expect(untitled.querySelector("img.workspace-desktop__tile-media")).not.toBeNull();
    expect(untitled.querySelector(".workspace-desktop__filename")).toBeNull();
    expect(tiles[1]!.querySelector(".workspace-desktop__filename")?.textContent).toBe("beta.png");
    expect(tiles[0]!.querySelector(".chat-attachment-file-icon")?.getAttribute("data-mode")).toBe(
      "large-placeholder",
    );
    tiles[0]!.click();
    expect(workspace.onOpenArtifact).toHaveBeenCalledWith("concept", "preview");

    mounted.update({ ...workspace, sessionFilesDisplay: { view: "grid", sort: "type" } });
    expect(labels()).toEqual(["beta.png", "Image", "alpha.pdf", "/tmp/zeta.txt"]);

    mounted.getByRole("button", { name: "Session files view and order" }).click();
    await waitForSolid(() => expect(mounted.getByRole("menu")).not.toBeNull());
    const listOption = mounted.getByRole("menuitemradio", { name: "List" });
    expect(mounted.getByRole("menuitemradio", { name: "Grid" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    listOption.click();
    expect(onSessionFilesDisplayChange).toHaveBeenCalledWith({ view: "list" });
    mounted.getByRole("button", { name: "Session files view and order" }).click();
    await waitForSolid(() => expect(mounted.getByRole("menu")).not.toBeNull());
    mounted.getByRole("menuitemradio", { name: "Date" }).click();
    expect(onSessionFilesDisplayChange).toHaveBeenLastCalledWith({ sort: "date" });
  } finally {
    mounted.unmount();
  }
});

it("remembers the session files display for every Files panel in this browser", () => {
  const previous = loadSettings().sessionFilesDisplay;
  onTestFinished(() => {
    patchSettings({ sessionFilesDisplay: previous });
  });
  patchSettings({ sessionFilesDisplay: undefined });
  const state = createSessionWorkspaceHost({ settings: loadSettings() });
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: false, presentation: "desktop" });
  expect(props().sessionFilesDisplay).toEqual({ view: "list", sort: "default" });
  props().onSessionFilesDisplayChange?.({ view: "grid" });
  expect(props().sessionFilesDisplay).toEqual({ view: "grid", sort: "default" });
  props().onSessionFilesDisplayChange?.({ sort: "name" });
  expect(loadSettings().sessionFilesDisplay).toEqual({ view: "grid", sort: "name" });
  const other = createSessionWorkspaceHost({
    sessionKey: "agent:main:other",
    settings: loadSettings(),
  });
  expect(
    createSessionWorkspaceProps(other, { expanded: false, presentation: "desktop" })
      .sessionFilesDisplay,
  ).toEqual({ view: "grid", sort: "name" });
});

it("mobile Files clears an accepted unavailable listing on force retry and hides rows on denied refresh", async () => {
  const retry = createDeferred<List>();
  const denied = createDeferred<List>();
  const listFiles = vi
    .fn()
    .mockResolvedValueOnce({ sessionKey: "agent:main:workspace", files: [] })
    .mockReturnValueOnce(retry.promise)
    .mockReturnValueOnce(denied.promise);
  const state = createSessionWorkspaceHost({
    sessionKey: "agent:main:workspace",
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    sessions: createSessionCapabilityFixture({ listFiles }),
    handleOpenSidebar: () => {},
  });
  const props = () =>
    createSessionWorkspaceProps(state, { expanded: true, presentation: "mobile" });
  const [current, setCurrent] = createSignal(props());
  const mounted = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
  const stop = sessionWorkspaceForHost(state).subscribe(() => setCurrent(props()));
  onTestFinished(() => {
    stop();
    mounted.unmount();
  });
  await waitForSolid(() => expect(mounted.getByRole("button", { name: "Retry" })).toBeTruthy());
  mounted.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() =>
    expect(mounted.container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull(),
  );
  expect(mounted.queryByRole("button", { name: "Retry" })).toBeNull();
  retry.resolve({ sessionKey: state.sessionKey, files: [file("private.md")] });
  await waitForSolid(() => expect(button(mounted.container, "private.md")).not.toBeNull());
  loadSessionWorkspace(state, getSessionWorkspace(state));
  await waitForSolid(() =>
    expect(mounted.container.querySelector("[aria-busy=true]")).not.toBeNull(),
  );
  expect(button(mounted.container, "private.md")).not.toBeNull();
  denied.reject(new Error("Access denied"));
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Access denied"),
  );
  expect(button(mounted.container, "private.md")).toBeNull();
  expect(listFiles).toHaveBeenCalledTimes(3);
});
