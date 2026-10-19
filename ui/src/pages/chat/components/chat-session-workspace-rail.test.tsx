/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import { getSessionWorkspace, loadSessionWorkspace } from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
  type SessionWorkspaceProps,
} from "./chat-session-workspace.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-content-types.ts";

type List = NonNullable<SessionWorkspaceProps["list"]>;
type WorkspaceFixture = Omit<Partial<SessionWorkspaceProps>, "list"> & {
  list?: Omit<List, "sessionKey">;
};

function createWorkspace(overrides: WorkspaceFixture = {}): SessionWorkspaceProps {
  return {
    sessionKey: "agent:main:workspace",
    loading: false,
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

function mountWorkspace(workspace: SessionWorkspaceProps) {
  const [current, setCurrent] = createSignal(workspace);
  const view = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
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

describe("session workspace path actions", () => {
  it.each([
    ["reports/monthly", false, "reports"],
    ["reports", true, null],
  ] as const)(
    "keeps folder recovery available for %s (loading: %s)",
    (path, loading, parentPath) => {
      const onBrowsePath = vi.fn();
      const workspace = createWorkspace({
        browserPath: path,
        loading,
        list: { files: [], root: "/workspace" },
        onBrowsePath,
      });
      const { container: mount } = mountWorkspace(workspace);
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
        getFile: vi.fn().mockResolvedValue({
          ...result,
          file: { ...entry, previewKind: "text", contentEncoding: "utf8", content: "# Readme" },
        }),
      },
    } as unknown as SessionWorkspaceHost;
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    const { container, update } = mountWorkspace(
      createSessionWorkspaceProps(state, { expanded: true }),
    );
    const renderRows = () => update(createSessionWorkspaceProps(state, { expanded: true }));
    renderRows();
    const preview = button(container, "Preview");
    assert(preview);
    preview.focus();
    preview.click();
    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
    );
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
    const { container: mount, update } = mountWorkspace(workspace);
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
    const { container: mount } = mountWorkspace(workspace);

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

  it("retains disclosure state and expands search matches", () => {
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
    const { container: mount, update } = mountWorkspace(workspace);
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
  ] as const)("recovers empty %s searches (browser: %s)", (filter, browser, restored) => {
    const workspace = createWorkspace({
      list: {
        files: [file("report.csv"), file("report.md", "read")],
        artifacts: [artifact("report", "Report")],
        ...(browser ? { browser: { path: "", entries: [] } } : {}),
      },
    });
    const { container: mount, update } = mountWorkspace(workspace);
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
    expect(mount.textContent).toContain(workspace.error);
  });

  it("matches every Files group without collapsing internal spaces", () => {
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
    const { container: mount, update } = mountWorkspace(workspace);
    expect(fileNames(mount)).toEqual(["a  b.csv", "a  b.md", "A  b", "a  b.csv"]);
    expect(searchInput(mount).value).toBe(query);

    update({ ...workspace, browserSearch: "   " });
    expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(6);
  });
});
