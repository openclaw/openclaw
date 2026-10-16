import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import {
  createSlashMenuState,
  SlashMenu,
  type SlashMenuHost,
} from "./chat-composer-slash-menu.tsx";

it("retains the slash viewport during selection changes and resets it when switching mode", () => {
  const state = createSlashMenuState();
  const command = { key: "status", name: "status", description: "Show status" };
  state.slashMenuOpen = true;
  state.slashMenuItems = [{ key: "help", name: "help", description: "Show help" }, command];
  const host: SlashMenuHost = {
    paneId: "menu-retention",
    getDraft: () => "/",
    commitDraft: vi.fn(),
    getTextarea: () => null,
    resolveArgOptions: () => [],
    runCommand: vi.fn(),
    canRun: () => true,
  };
  const update = vi.fn();
  const [args, setArgs] = createSignal<[typeof state, SlashMenuHost, string, () => void]>([
    state,
    host,
    "/",
    update,
  ]);
  const view = mountSolid(() => <SlashMenu args={args()} />);
  const viewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  viewport.scrollTop = 120;
  state.slashMenuIndex = 1;
  setArgs([state, host, "/", update]);
  flush();
  expect(view.container.querySelector(".slash-menu__scroll")).toBe(viewport);
  expect(viewport.scrollTop).toBe(120);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status");

  state.slashMenuMode = "args";
  state.slashMenuCommand = command;
  state.slashMenuArgItems = ["on", "off"];
  state.slashMenuIndex = 0;
  setArgs([state, host, "/status ", update]);
  flush();
  const argumentsViewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  expect(argumentsViewport).not.toBe(viewport);
  expect(argumentsViewport.scrollTop).toBe(0);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status on");

  state.slashMenuOpen = false;
  setArgs([state, host, "/status on", update]);
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
