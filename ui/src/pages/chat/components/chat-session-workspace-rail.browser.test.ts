import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "../../../i18n/index.ts";
import { renderSessionWorkspaceRail } from "./chat-session-workspace-rail.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

function mountWorkspace(overrides: Partial<SessionWorkspaceProps> = {}) {
  const workspace: SessionWorkspaceProps = {
    collapsed: false,
    sessionKey: "agent:main:workspace",
    list: {
      sessionKey: "agent:main:workspace",
      root: "/synthetic/project",
      files: [{ kind: "modified", name: "edited.ts", path: "src/edited.ts", missing: false }],
      browser: {
        path: "",
        entries: [
          { kind: "file", name: "browser.ts", path: "src/browser.ts" },
          { kind: "directory", name: "docs", path: "docs" },
        ],
      },
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
  const mount = document.body.appendChild(document.createElement("div"));
  render(renderSessionWorkspaceRail(workspace), mount);
  return { workspace, mount };
}

const menu = () => page.getByRole("menu", { name: "Workspace file actions" });

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  // Dismiss through the menu owner so document listeners and focus state are released.
  await userEvent.keyboard("{Escape}");
  document.body.replaceChildren();
});

describe("workspace rail file context menus", () => {
  it.each([
    { path: "src/edited.ts", source: "session" as const, browser: false },
    { path: "src/browser.ts", source: "workspace" as const, browser: true },
  ])("previews $source files from the row and its preview action", async (testCase) => {
    const { workspace, mount } = mountWorkspace();
    const listSelector = testCase.browser
      ? ".chat-workspace-rail__list--browser"
      : ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser)";
    const row = mount.querySelector<HTMLElement>(`${listSelector} .chat-workspace-rail__file`)!;
    for (const selector of [".chat-workspace-rail__file-open", 'button[aria-label="Preview"]']) {
      await userEvent.click(row.querySelector<HTMLButtonElement>(selector)!, { button: "right" });
      expect(workspace.onOpenFile).not.toHaveBeenCalled();
      await menu().getByRole("menuitem", { name: "Preview", exact: true }).click();
      expect(workspace.onOpenFile).toHaveBeenCalledExactlyOnceWith(testCase.path, testCase.source);
      expect(workspace.onOpenArtifact).not.toHaveBeenCalled();
      expect(workspace.onBrowsePath).not.toHaveBeenCalled();
      vi.mocked(workspace.onOpenFile).mockClear();
    }
  });

  it("previews the artifact id without offering a relative file path", async () => {
    const { workspace, mount } = mountWorkspace({ filter: "artifacts" });
    const trigger = mount.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!;
    await userEvent.click(trigger, { button: "right" });
    await expect.element(menu()).toBeVisible();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(["Preview", "Copy filename", "Refresh"]);
    await menu().getByRole("menuitem", { name: "Preview", exact: true }).click();
    expect(workspace.onOpenArtifact).toHaveBeenCalledExactlyOnceWith("portrait-1");
    expect(workspace.onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps directories as browse targets without file context actions", async () => {
    const { workspace, mount } = mountWorkspace();
    const row = mount.querySelector<HTMLElement>(".chat-workspace-rail__file--directory")!;
    const trigger = row.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!;
    await userEvent.click(trigger, { button: "right" });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(row.querySelector('[aria-label="Preview"]')).toBeNull();
    trigger.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger);
    expect(workspace.onBrowsePath).toHaveBeenCalledExactlyOnceWith("docs");
    expect(workspace.onOpenFile).not.toHaveBeenCalled();
  });

  it.each(["Escape", "Tab"])(
    "restores the rail trigger after keyboard %s dismissal",
    async (key) => {
      const { workspace, mount } = mountWorkspace();
      const trigger = mount.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!;
      trigger.focus();
      await userEvent.keyboard("{Shift>}{F10}{/Shift}");
      await expect
        .element(menu().getByRole("menuitem", { name: "Preview", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard(`{${key}}`);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(workspace.onOpenFile).not.toHaveBeenCalled();
    },
  );
});
