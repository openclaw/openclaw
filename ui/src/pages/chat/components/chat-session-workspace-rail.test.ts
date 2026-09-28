/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function createWorkspace(overrides: Partial<SessionWorkspaceProps> = {}): SessionWorkspaceProps {
  return {
    collapsed: false,
    sessionKey: "agent:main:workspace",
    list: null,
    loading: false,
    error: null,
    activeId: null,
    filter: "all",
    browserPath: "",
    browserSearch: "",
    dock: "right",
    narrowLayout: false,
    onToggleCollapsed: vi.fn(),
    onSetDock: vi.fn(),
    onRefresh: vi.fn(),
    onBrowsePath: vi.fn(),
    onOpenFile: vi.fn(),
    onSearch: vi.fn(),
    onSetFilter: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("session workspace path actions", () => {
  it.each([
    { path: "reports", search: "", loading: false, parent: "" },
    { path: "reports/monthly", search: "", loading: false, parent: "reports" },
    { path: "", search: "", loading: false, parent: null },
    { path: "reports", search: "notes", loading: false, parent: null },
    { path: "reports", search: "", loading: true, parent: null },
  ])("keeps only settled non-root folder recovery available: %j", (scenario) => {
    const onBrowsePath = vi.fn();
    const workspace = createWorkspace({
      browserPath: scenario.path,
      browserSearch: scenario.search,
      loading: scenario.loading,
      list: { sessionKey: "agent:main:workspace", root: "/workspace", files: [] },
      onBrowsePath,
    });
    const mount = document.body.appendChild(document.createElement("div"));
    render(renderSessionWorkspaceRail(workspace, { embedded: true }), mount);
    const parent = mount.querySelector<HTMLButtonElement>('button[aria-label=".."]');
    if (scenario.parent === null) {
      expect(parent).toBeNull();
      expect(mount.textContent).not.toContain("This folder is unavailable.");
    } else {
      expect(parent).not.toBeNull();
      expect(mount.textContent).toContain("This folder is unavailable.");
      parent!.click();
      expect(onBrowsePath).toHaveBeenCalledExactlyOnceWith(scenario.parent);
    }
  });

  it("keeps path-only session rows selected after their read and refresh", async () => {
    const file = { kind: "modified", path: "README.md", name: "README.md", missing: false };
    const result = { sessionKey: "agent:main:current", root: "/workspace", files: [file] };
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
        getFile: vi.fn().mockResolvedValue({ ...result, file: { ...file, content: "# Readme" } }),
      },
    } as unknown as SessionWorkspaceHost;
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    const container = document.createElement("div");
    const renderRows = () =>
      render(
        renderSessionWorkspaceRail(createSessionWorkspaceProps(state, { expanded: true })),
        container,
      );
    renderRows();
    container.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!.click();
    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
    );
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
    createSessionWorkspaceProps(state).onRefresh();
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
  });

  it.each(["/synthetic/very-long-workspace-prefix", "C:\\synthetic\\very-long-workspace-prefix"])(
    "keeps session file labels readable and distinct under %s",
    async (root) => {
      const separator = root.includes("\\") ? "\\" : "/";
      const path = (...parts: string[]) => [root, ...parts].join(separator);
      const paths = [path("inventory.csv"), path("ui", "index.ts"), path("api", "index.ts")];
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const onOpenFile = vi.fn();
      const workspace = createWorkspace({
        list: {
          sessionKey: "agent:main:workspace",
          root,
          files: paths.map((filePath, index) => ({
            kind: index === 2 ? "read" : "modified",
            path: filePath,
            name: index === 0 ? "inventory.csv" : "index.ts",
            missing: false,
          })),
        },
        activeId: `file:${paths[1]}`,
        onOpenFile,
      });
      const mount = document.body.appendChild(document.createElement("div"));
      const renderRows = () => render(renderSessionWorkspaceRail(workspace), mount);
      const labels = () =>
        [...mount.querySelectorAll(".chat-workspace-rail__file-name")].map(
          (row) => row.textContent,
        );
      renderRows();
      expect(labels()).toEqual([
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
        row.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]')!.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(paths[index]));
      }
      const selectedRow = rows[1];
      assert(selectedRow, "Expected the selected ui/index.ts row");
      expect(selectedRow.classList.contains("chat-workspace-rail__file--active")).toBe(true);
      workspace.filter = "changed";
      renderRows();
      expect(labels()).toEqual(["inventory.csv", `ui${separator}index.ts`]);
      workspace.browserSearch = `ui${separator}index`;
      renderRows();
      expect(labels()).toEqual([`ui${separator}index.ts`]);
    },
  );

  it.each([
    {
      surface: "session Files",
      selector: ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser)",
      path: "src/edited.ts",
      origin: "session" as const,
      failed: true,
      feedback: "Copy failed",
    },
    {
      surface: "project browser",
      selector: ".chat-workspace-rail__list--browser",
      path: "src/browser.ts",
      origin: "workspace" as const,
      failed: false,
      feedback: "Copied!",
    },
  ])("shows $feedback when copying a $surface path", async (testCase) => {
    const writeText = testCase.failed
      ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
      : vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onOpenFile = vi.fn();
    const workspace = createWorkspace({
      list: {
        sessionKey: "agent:main:workspace",
        root: "/synthetic/project",
        files: [{ kind: "modified", name: "edited.ts", path: "src/edited.ts", missing: false }],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "browser.ts", path: "src/browser.ts" }],
        },
      },
      onOpenFile,
    });
    const mount = document.body.appendChild(document.createElement("div"));
    render(renderSessionWorkspaceRail(workspace), mount);

    const row = mount.querySelector<HTMLElement>(`${testCase.selector} .chat-workspace-rail__file`);
    expect(row).toBeInstanceOf(HTMLElement);
    const rowClick = vi.fn();
    row!.addEventListener("click", rowClick);
    const copy = row!.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]');
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    copy!.click();
    await vi.waitFor(() => expect(copy!.getAttribute("aria-label")).toBe(testCase.feedback));

    expect(writeText).toHaveBeenCalledWith(testCase.path);
    const feedback = copy!.parentElement?.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe(testCase.feedback);
    expect(feedback?.hidden).toBe(false);
    expect(rowClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();

    const preview = row!.querySelector<HTMLButtonElement>('button[aria-label="Preview"]');
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview!.click();
    expect(onOpenFile).toHaveBeenCalledWith(testCase.path, testCase.origin);
  });

  it("preserves disclosure toggles across renders and opens matching groups during search", () => {
    const workspace = createWorkspace({
      list: {
        sessionKey: "agent:main:workspace",
        files: [{ kind: "modified", name: "edited.ts", path: "src/edited.ts", missing: false }],
        artifacts: [
          {
            id: "portrait-1",
            title: "Portrait",
            mimeType: "image/jpeg",
            type: "image",
            download: { mode: "bytes" },
            sizeBytes: 2048,
          },
        ],
      },
    });
    const mount = document.body.appendChild(document.createElement("div"));

    render(renderSessionWorkspaceRail(workspace), mount);
    const [changed, artifacts] = mount.querySelectorAll("details");
    assert(changed && artifacts, "Expected Changed and Artifacts disclosures");
    expect(changed.open).toBe(true);
    expect(artifacts.open).toBe(false);
    changed.querySelector("summary")!.click();
    artifacts.querySelector("summary")!.click();

    render(renderSessionWorkspaceRail({ ...workspace, activeId: "artifact:portrait-1" }), mount);

    expect(changed.open).toBe(false);
    expect(artifacts.open).toBe(true);
    artifacts.querySelector("summary")!.click();
    workspace.browserSearch = "IMAGE";
    render(renderSessionWorkspaceRail(workspace), mount);

    expect(mount.querySelectorAll(".chat-workspace-rail__group")).toHaveLength(1);
    expect(mount.querySelector("summary")?.textContent).toContain("Artifacts");
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.textContent).toContain("Portrait");
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).toBeNull();
    expect(mount.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("IMAGE");

    workspace.browserSearch = "";
    render(renderSessionWorkspaceRail(workspace), mount);
    mount.querySelector("summary")!.click();
    expect(mount.querySelector("details")?.open).toBe(false);
    render(renderSessionWorkspaceRail({ ...workspace, filter: "changed" }), mount);

    expect(mount.querySelectorAll("details")).toHaveLength(1);
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).not.toBeNull();
  });

  it.each(["inventory  report", "  INVENTORY  REPORT  ", "\tinventory  report\t"])(
    "matches every Files group consistently for %j without collapsing internal spaces",
    (query) => {
      const workspace = createWorkspace({
        browserSearch: query,
        list: {
          sessionKey: "agent:main:workspace",
          files: [
            {
              kind: "modified",
              name: "inventory  report.csv",
              path: "inventory  report.csv",
              missing: false,
            },
            {
              kind: "read",
              name: "inventory  report.md",
              path: "inventory  report.md",
              missing: false,
            },
            {
              kind: "modified",
              name: "inventory report.csv",
              path: "inventory report.csv",
              missing: false,
            },
          ],
          artifacts: [
            { id: "report", title: "Inventory  report", type: "file", download: { mode: "bytes" } },
            { id: "other", title: "Inventory report", type: "file", download: { mode: "bytes" } },
          ],
          browser: {
            path: "",
            search: "inventory  report",
            entries: [
              { kind: "file", name: "inventory  report.csv", path: "inventory  report.csv" },
            ],
          },
        },
      });
      const mount = document.body.appendChild(document.createElement("div"));
      render(renderSessionWorkspaceRail(workspace), mount);
      expect(
        Array.from(
          mount.querySelectorAll(".chat-workspace-rail__file-name"),
          (row) => row.textContent,
        ),
      ).toEqual([
        "inventory  report.csv",
        "inventory  report.md",
        "Inventory  report",
        "inventory  report.csv",
      ]);
      expect(mount.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(query);

      render(renderSessionWorkspaceRail({ ...workspace, browserSearch: "   " }), mount);
      expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(6);
    },
  );

  it("omits filter chips when only project files are available", () => {
    const workspace = createWorkspace({
      filter: "read",
      list: {
        sessionKey: "agent:main:workspace",
        files: [],
        artifacts: [],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "README.md", path: "README.md" }],
        },
      },
    });
    const mount = document.body.appendChild(document.createElement("div"));

    render(renderSessionWorkspaceRail(workspace), mount);

    expect(mount.querySelector('[role="group"][aria-label="Filter files"]')).toBeNull();
    expect(mount.querySelector('input[type="search"]')).toBeInstanceOf(HTMLInputElement);
    expect(mount.querySelector("summary")?.textContent).toContain("Project files");
    expect(mount.textContent).toContain("README.md");
  });
});
