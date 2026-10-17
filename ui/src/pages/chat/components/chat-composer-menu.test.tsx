import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import { createSlashMenu, SlashMenu, type SlashMenuHost } from "./chat-composer-slash-menu.tsx";

it("retains the slash viewport during selection changes and resets it when switching mode", () => {
  const command = { key: "status", name: "status", description: "Show status" };
  const host: SlashMenuHost = {
    paneId: "menu-retention",
    getDraft: () => "/",
    commitDraft: vi.fn(),
    getTextarea: () => null,
    resolveArgOptions: () => [],
    runCommand: vi.fn(),
    canRun: () => true,
  };
  let menu!: ReturnType<typeof createSlashMenu>;
  const view = mountSolid(() => {
    menu = createSlashMenu();
    return <SlashMenu menu={menu} host={host} draft="/" />;
  });
  menu.update("/", host);
  flush();
  const viewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  viewport.scrollTop = 120;
  menu.hover(menu.state.slashMenuItems.findIndex((entry) => entry.key === "status"));
  flush();
  expect(view.container.querySelector(".slash-menu__scroll")).toBe(viewport);
  expect(viewport.scrollTop).toBe(120);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status");

  host.resolveArgOptions = () => ["on", "off"];
  menu.selectCommand(command, host);
  flush();
  const argumentsViewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  expect(argumentsViewport).not.toBe(viewport);
  expect(argumentsViewport.scrollTop).toBe(0);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status on");

  menu.reset();
  flush();
  expect(view.queryByRole("listbox")).toBeNull();
});

it("retains the focused capability row and management link through catalog refreshes", async () => {
  type Menu = Parameters<typeof ChatComposerPlusMenu>[0]["menu"];
  const onNavigate = vi.fn();
  const [menu, setMenu] = createSignal<Menu>({
    attachments: {},
    disabled: false,
    open: true,
    view: "skills",
    toolOverrides: null,
    onOpenChange: vi.fn(),
    onViewChange: vi.fn(),
    capabilityMenu: {
      basePath: "/control",
      skills: [
        { key: "focused", name: "Focused skill", enabled: true, baseEnabled: true },
        { key: "broken", name: "Broken", enabled: false, baseEnabled: false, missingDeps: true },
        { key: "private", name: "Private", enabled: false, baseEnabled: false, blocked: true },
      ],
      skillsLoading: false,
      skillsError: false,
      mcpServers: [],
      toolsEffectiveResult: null,
      toolsEffectiveLoading: false,
      toolsEffectiveError: false,
      toolAccessMutationBlockedReason: null,
      webSearchBaseEnabled: true,
      mutationBlockedReason: null,
      canAdmin: true,
      adminBlockedReason: null,
      onLoadSkills: vi.fn(),
      onPatchToolOverrides: vi.fn(),
      onNavigate,
    },
  });
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu()} />);
  for (const name of ["Broken deps missing", "Private not available for this agent"]) {
    expect(
      view.getByRole("menuitemcheckbox", { name, hidden: true }).hasAttribute("disabled"),
    ).toBe(true);
  }
  expect(view.getByRole("menuitemcheckbox", { name: "Focused skill", hidden: true })).toBeTruthy();
  const row = view.container.querySelector<HTMLButtonElement>('[data-value="skill:focused"]')!;
  await waitForSolid(() =>
    expect(row.closest("[data-menu-content]")?.getAttribute("data-phase")).toBe("open"),
  );
  expect(row.closest("[data-menu-content]")?.matches(":popover-open")).toBe(true);
  row.focus();
  expect(document.activeElement).toBe(row);

  setMenu((previous) => ({
    ...previous,
    capabilityMenu: {
      ...previous.capabilityMenu!,
      skillsLoading: true,
      skills: [{ key: "focused", name: "Focused skill", enabled: false, baseEnabled: true }],
    },
  }));
  flush();
  expect(view.container.querySelector('[data-value="skill:focused"]')).toBe(row);
  expect(document.activeElement).toBe(row);
  await waitForSolid(() => expect(row.getAttribute("aria-checked")).toBe("false"));

  setMenu((previous) => ({
    ...previous,
    capabilityMenu: {
      ...previous.capabilityMenu!,
      skillsLoading: false,
      skills: [
        { key: "new", name: "New skill", enabled: true, baseEnabled: true },
        { key: "focused", name: "Refreshed skill", enabled: false, baseEnabled: true },
      ],
    },
  }));
  await waitForSolid(() => {
    expect(view.container.querySelector('[data-value="skill:focused"]')).toBe(row);
    expect(row.textContent).toContain("Refreshed skill");
  });
  expect(row.getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement).toBe(row);

  const manage = view.getByRole("menuitem", { name: "Manage skills", hidden: true });
  expect(manage.getAttribute("href")).toBe("/control/skills");
  const modifiedClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  manage.dispatchEvent(modifiedClick);
  expect(modifiedClick.defaultPrevented).toBe(false);
  expect(onNavigate).not.toHaveBeenCalled();
  manage.click();
  await waitForSolid(() => expect(onNavigate).toHaveBeenCalledExactlyOnceWith("skills"));

  setMenu((previous) => ({
    ...previous,
    view: "connectors",
    toolOverrides: { mcpServers: { docs: true } },
    capabilityMenu: {
      ...previous.capabilityMenu!,
      mcpServers: [
        {
          name: "docs",
          enabled: false,
          transport: "stdio",
          target: "docs-server",
          auth: null,
          signIn: null,
          toolFilter: false,
          parallel: false,
          tls: null,
        },
      ],
    },
  }));
  await waitForSolid(() =>
    expect(
      view.getByRole("menuitemcheckbox", { name: "docs Enabled session", hidden: true }),
    ).toBeTruthy(),
  );
  const connector = view.getByRole("menuitemcheckbox", {
    name: "docs Enabled session",
    hidden: true,
  });
  setMenu((previous) => ({ ...previous, toolOverrides: null }));
  await waitForSolid(() =>
    expect(view.getByRole("menuitemcheckbox", { name: "docs Disabled", hidden: true })).toBe(
      connector,
    ),
  );

  setMenu((previous) => ({
    ...previous,
    view: "tools:docs",
    capabilityMenu: {
      ...previous.capabilityMenu!,
      toolsEffectiveResult: {
        agentId: "main",
        profile: "full",
        groups: [
          {
            id: "mcp",
            label: "MCP",
            source: "mcp",
            tools: [
              {
                id: "docs_search",
                label: "Search documents",
                description: "Search",
                rawDescription: "Search",
                source: "mcp",
                mcpServer: "docs",
                mcpToolName: "search",
              },
              {
                id: "docs_list",
                label: "list",
                description: "List",
                rawDescription: "List",
                source: "mcp",
                mcpServer: "docs",
                mcpToolName: "list",
              },
            ],
          },
        ],
      },
    },
  }));
  await waitForSolid(() => {
    expect(
      view.getByRole("menuitemcheckbox", { name: "search Search documents", hidden: true }),
    ).toBeTruthy();
    expect(view.getByRole("menuitemcheckbox", { name: "list", hidden: true })).toBeTruthy();
  });
});

it("retains attachment choices while the native menu closes and reopens", async () => {
  const [open, setOpen] = createSignal(false);
  const toggle = {
    value: "test-toggle",
    label: "Test toggle",
    checked: false,
    disabled: false,
    onChange: vi.fn(),
  };
  const view = mountSolid(() => (
    <ChatComposerPlusMenu
      menu={{
        attachments: {},
        disabled: false,
        open: open(),
        view: "root",
        toolOverrides: null,
        rootToggles: [{ ...toggle, icon: "pencil" }],
        onOpenChange: setOpen,
        onViewChange: vi.fn(),
      }}
    />
  ));
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  trigger.click();
  await waitForSolid(() => expect(open()).toBe(true));
  const choice = view.getByRole("menuitemcheckbox", { name: "Test toggle", hidden: true });
  expect(choice.querySelector("svg")).not.toBeNull();
  setOpen(false);
  flush();
  setOpen(true);
  flush();
  expect(view.container.querySelector('[data-value="test-toggle"]')).toBe(choice);
});

it.each(["item", "external", "closed"] as const)(
  "preserves newer %s focus after changing capability views",
  async (target) => {
    type Menu = Parameters<typeof ChatComposerPlusMenu>[0]["menu"];
    const [currentView, setView] = createSignal<Menu["view"]>(
      target === "closed" ? "connectors" : "tools:docs",
    );
    const [open, setOpen] = createSignal(true);
    const view = mountSolid(() => (
      <>
        <input aria-label="Newer focus" />
        <ChatComposerPlusMenu
          menu={{
            attachments: {},
            disabled: false,
            open: open(),
            view: currentView(),
            toolOverrides: null,
            onOpenChange: setOpen,
            onViewChange: setView,
            capabilityMenu: {
              basePath: "/control",
              skills: [],
              skillsLoading: false,
              skillsError: false,
              mcpServers: [
                {
                  name: "docs",
                  enabled: true,
                  transport: "stdio",
                  target: "docs-server",
                  auth: null,
                  signIn: null,
                  toolFilter: false,
                  parallel: false,
                  tls: null,
                },
              ],
              toolsEffectiveResult: null,
              toolsEffectiveLoading: false,
              toolsEffectiveError: false,
              toolAccessMutationBlockedReason: null,
              webSearchBaseEnabled: true,
              mutationBlockedReason: null,
              canAdmin: true,
              adminBlockedReason: null,
              onLoadSkills: vi.fn(),
              onPatchToolOverrides: vi.fn(),
              onNavigate: vi.fn(),
            },
          }}
        />
      </>
    ));
    const back = view.getByRole("menuitem", { name: "Back", hidden: true });
    await waitForSolid(() =>
      expect(back.closest("[data-menu-content]")?.getAttribute("data-phase")).toBe("open"),
    );
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      back.focus();
      back.click();
      let focused: HTMLElement;
      if (target === "item") {
        flush();
        expect(document.activeElement).toBe(back);
        focused = view.getByRole("menuitemcheckbox", { name: "docs Enabled", hidden: true });
      } else if (target === "closed") {
        setOpen(false);
        focused = document.body;
      } else {
        focused = view.getByRole("textbox", { name: "Newer focus" });
      }
      if (target !== "closed") {
        focused.focus();
      }
      flush();
      for (const callback of frames) {
        callback(0);
      }
      expect(document.activeElement).toBe(focused);
      if (target === "item") {
        back.focus();
        back.click();
        flush();
        expect(back.isConnected).toBe(false);
        expect(document.activeElement).toBe(
          view.getByRole("menuitem", { name: "Take photo", hidden: true }),
        );
      }
    } finally {
      raf.mockRestore();
    }
  },
);
