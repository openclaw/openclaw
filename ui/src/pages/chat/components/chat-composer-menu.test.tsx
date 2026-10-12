import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
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

it("retains the focused capability row through toggles and a reordered catalog refresh", async () => {
  type Menu = Parameters<typeof ChatComposerPlusMenu>[0]["menu"];
  const [menu, setMenu] = createSignal<Menu>({
    attachments: {},
    disabled: false,
    open: true,
    view: "skills",
    toolOverrides: null,
    onOpenChange: vi.fn(),
    onViewChange: vi.fn(),
    capabilityMenu: {
      basePath: "",
      skills: [{ key: "focused", name: "Focused skill", enabled: true, baseEnabled: true }],
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
      onNavigate: vi.fn(),
    },
  });
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu()} />);
  const dropdown = view.container.querySelector<WaDropdown>("wa-dropdown")!;
  const row = view.container.querySelector<WaDropdownItem>('wa-dropdown-item[value="skill:0"]')!;
  await Promise.all([dropdown.updateComplete, row.updateComplete]);
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
  expect(view.container.querySelector('wa-dropdown-item[value="skill:0"]')).toBe(row);
  expect(document.activeElement).toBe(row);
  await waitForSolid(() => expect(row.checked).toBe(false));

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
    expect(view.container.querySelector('wa-dropdown-item[value="skill:1"]')).toBe(row);
    expect(row.textContent).toContain("Refreshed skill");
  });
  expect(row.checked).toBe(false);
  expect(document.activeElement).toBe(row);
});
