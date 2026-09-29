/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, readPanelHostedTabs } from "../panel-hosted-tabs.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import { terminalPanelHostedTabs, type TerminalPanelTab } from "./terminal-panel-tabs.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const tagName = defineTestTerminalPanelElement(createGhosttyTerminalMock);

async function mount(embedded = true, tabsInHeader = true) {
  let sequence = 0;
  const client: TerminalGatewayClient = {
    forceReconnect: () => {},
    request: async <T>(method: string) =>
      (method === "terminal.open"
        ? terminalOpenResult(`session-${++sequence}`)
        : method === "terminal.list"
          ? { sessions: [] }
          : {}) as T,
    addEventListener: () => () => {},
  };
  const panel = document.createElement(tagName) as OpenClawTerminalPanel;
  panel.available = true;
  panel.embedded = embedded;
  panel.tabsInHeader = tabsInHeader;
  panel.client = client;
  document.body.append(panel);
  if (!embedded) {
    panel.toggle();
  }
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  const sessions = (panel as unknown as { terminalSessions: TerminalPanelSessionController })
    .terminalSessions;
  await waitForFast(() => expect(sessions.booting).toBe(false));
  await panel.updateComplete;
  return { panel, sessions };
}

function mountActions(panel: OpenClawTerminalPanel) {
  const container = document.createElement("div");
  document.body.append(container);
  const update = () => render(panel.hostedActions, container);
  panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, update);
  update();
  return container;
}

function button(container: HTMLElement, label: string) {
  const element = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe("Terminal panel hosted tabs", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    createGhosttyTerminalMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { embedded: true, tabsInHeader: true, ownsStrip: false },
    { embedded: true, tabsInHeader: false, ownsStrip: true },
    { embedded: false, tabsInHeader: true, ownsStrip: true },
  ])(
    "keeps its own chrome=$ownsStrip for embedded=$embedded and tabsInHeader=$tabsInHeader",
    async ({ embedded, tabsInHeader, ownsStrip }) => {
      const { panel } = await mount(embedded, tabsInHeader);
      expect(Boolean(panel.renderRoot.querySelector(".tp-header"))).toBe(ownsStrip);
      expect(Boolean(panel.renderRoot.querySelector(".tp-actions"))).toBe(ownsStrip);
      expect(panel.renderRoot.querySelector(".tp-viewport")).not.toBeNull();
      expect(panel.renderRoot.querySelector(".tp-file-input")).not.toBeNull();
      expect(panel.renderRoot.querySelector(".tp-viewport")?.getAttribute("aria-labelledby")).toBe(
        ownsStrip ? `terminal-tab-${panel.activeHostedTabId}` : null,
      );
      expect(panel.hostedActions === nothing).toBe(ownsStrip);
      expect(readPanelHostedTabs(panel)).toBe(panel);
    },
  );

  it("projects shell labels, status, workspace hints, and agent ownership for either strip", () => {
    const base: TerminalPanelTab = {
      id: "live",
      sequence: 1,
      shellName: "zsh",
      agentId: "ops",
      cwd: "/work/ops",
      status: "live",
    };
    const tabs = terminalPanelHostedTabs([
      base,
      {
        ...base,
        id: "connecting",
        sequence: 2,
        shellName: null,
        status: "connecting",
        agentId: null,
      },
      { ...base, id: "exited", status: "exited", exitReason: "process_exit", exitCode: 3 },
      { ...base, id: "agent", agentOwned: true },
    ]);
    expect(tabs.map(({ icon: _icon, ...tab }) => tab)).toEqual([
      {
        id: "live",
        label: "zsh",
        title: "ops · /work/ops",
        statusLabel: null,
        badge: null,
        className: "is-live",
      },
      {
        id: "connecting",
        label: "shell 2",
        title: null,
        statusLabel: "Connecting to session…",
        badge: null,
        className: "is-connecting",
      },
      {
        id: "exited",
        label: "zsh",
        title: "ops · /work/ops",
        statusLabel: "exited (3)",
        badge: null,
        className: "is-exited",
      },
      {
        id: "agent",
        label: "zsh",
        title: "ops · /work/ops",
        statusLabel: null,
        badge: "agent",
        className: "is-live",
      },
    ]);
    const glyph = document.createElement("div");
    render(tabs[0]?.icon, glyph);
    expect(glyph.querySelector("path")?.getAttribute("d")).toBe("M3 4l3 3-3 3M8 11h5");
  });

  it("selects and closes through the session owner and resolves close after rendering", async () => {
    const { panel, sessions } = await mount();
    await sessions.openSession();
    const firstId = sessions.tabs[0]!.id;
    const select = vi.spyOn(sessions, "switchTo");
    const close = vi.spyOn(sessions, "closeTab");
    panel.selectHostedTab(firstId);
    expect(select).toHaveBeenCalledWith(firstId);
    expect(panel.activeHostedTabId).toBe(firstId);
    await panel.closeHostedTab(firstId);
    expect(close).toHaveBeenCalledWith(firstId);
    expect(panel.hostedTabs.some((tab) => tab.id === firstId)).toBe(false);
    expect(panel.isUpdatePending).toBe(false);
  });

  it("notifies on tab, selection, booting and header handoff changes, without repeating unrelated renders", async () => {
    const { panel, sessions } = await mount();
    const changed = vi.fn();
    document.body.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    try {
      sessions.tabs[0]!.shellName = "bash";
      panel.requestUpdate();
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(1);
      sessions.activeId = null;
      panel.requestUpdate();
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(2);
      sessions.booting = true;
      panel.requestUpdate();
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(3);
      expect(changed.mock.calls[0]?.[0]).toMatchObject({
        target: panel,
        bubbles: true,
        composed: true,
      });
      panel.themeMode = "light";
      await panel.updateComplete;
      panel.requestUpdate();
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(3);
      panel.tabsInHeader = false;
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(4);
      panel.tabsInHeader = true;
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(5);
    } finally {
      document.body.removeEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    }
  });

  it("opens another shell for an explicit new-session toggle", async () => {
    const { panel, sessions } = await mount();
    panel.handleToggleRequest(
      new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
        detail: { open: true, newSession: true },
      }),
    );
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() => expect(sessions.booting).toBe(false));
    expect(panel.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true);
  });

  it("offers three light-DOM actions with upload availability", async () => {
    const { panel, sessions } = await mount();
    const actions = mountActions(panel);
    expect(
      [...actions.querySelectorAll("button")].map((control) => control.getAttribute("aria-label")),
    ).toEqual(["Terminal sessions", "Add files to terminal", "Dock to bottom"]);
    expect(actions.querySelectorAll("openclaw-tooltip > .rail-header__action")).toHaveLength(3);
    expect(actions.querySelector('[class*="tp-"]')).toBeNull();
    const inputClick = vi.spyOn(
      panel.renderRoot.querySelector<HTMLInputElement>(".tp-file-input")!,
      "click",
    );
    button(actions, "Add files to terminal").click();
    expect(inputClick).toHaveBeenCalledOnce();
    const dock = vi.fn();
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    try {
      button(actions, "Dock to bottom").click();
      expect(dock.mock.calls[0]?.[0].detail).toMatchObject({ dock: "bottom", open: true });
    } finally {
      window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    }
    expect(button(actions, "Add files to terminal").disabled).toBe(false);
    const pending = vi
      .spyOn(panel.terminalPanelUploadController, "hasPendingBatch")
      .mockReturnValue(true);
    panel.requestUpdate();
    await panel.updateComplete;
    expect(button(actions, "Add files to terminal").disabled).toBe(true);
    pending.mockRestore();
    sessions.activeId = null;
    panel.requestUpdate();
    await panel.updateComplete;
    expect(button(actions, "Add files to terminal").disabled).toBe(true);
  });

  it("opens its shadow menu from light DOM and restores focus on Escape", async () => {
    const { panel } = await mount();
    const actions = mountActions(panel);
    const trigger = button(actions, "Terminal sessions");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    trigger.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.activeElement).toBe(
        panel.renderRoot.querySelector(".tp-session-refresh"),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = panel.renderRoot.querySelector(".tp-session-menu.tp-session-menu--hosted")!;
    expect(menu).not.toBeNull();
    expect(actions.querySelector(".tp-session-menu")).toBeNull();
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBe(menu);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await panel.updateComplete;
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();
  });
});
