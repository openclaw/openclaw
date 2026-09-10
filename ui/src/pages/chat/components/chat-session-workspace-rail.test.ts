/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

function createWorkspace(overrides: Partial<SessionWorkspaceProps> = {}): SessionWorkspaceProps {
  return {
    collapsed: false,
    sessionKey: "agent:main:workspace",
    list: null,
    loading: false,
    error: null,
    activeId: null,
    filter: "all",
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
  it("renders file-shaped placeholders while the initial workspace list loads", async () => {
    const workspace = createWorkspace({ loading: true });
    const mount = document.body.appendChild(document.createElement("div"));

    render(renderSessionWorkspaceRail(workspace, { embedded: true }), mount);

    const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
    expect(skeleton).toBeInstanceOf(HTMLElement);
    await (skeleton as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("files");
    expect(skeleton?.shadowRoot?.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    expect(mount.textContent).not.toContain("Loading session workspace");
  });

  it.each(
    [
      {
        surface: "session Files",
        selector: ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser)",
        path: "src/edited.ts",
        origin: "session" as const,
      },
      {
        surface: "project browser",
        selector: ".chat-workspace-rail__list--browser",
        path: "src/browser.ts",
        origin: "workspace" as const,
      },
    ].flatMap((surface) =>
      [false, true].map((failed) => ({
        surface: surface.surface,
        selector: surface.selector,
        path: surface.path,
        origin: surface.origin,
        failed,
        feedback: failed ? "Copy failed" : "Copied!",
      })),
    ),
  )("shows $feedback when copying a $surface path", async (testCase) => {
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
    expect(mount.textContent).not.toContain("src/edited.ts");
    expect(mount.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("IMAGE");

    workspace.browserSearch = "";
    render(renderSessionWorkspaceRail(workspace), mount);
    mount.querySelector("summary")!.click();
    expect(mount.querySelector("details")?.open).toBe(false);
    render(renderSessionWorkspaceRail({ ...workspace, filter: "changed" }), mount);

    expect(mount.querySelectorAll("details")).toHaveLength(1);
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.textContent).toContain("src/edited.ts");
  });

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
