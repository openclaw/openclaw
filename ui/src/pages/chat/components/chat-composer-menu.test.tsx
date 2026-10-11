import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
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
