/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, readPanelHostedTabs } from "../panel-hosted-tabs.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { terminalPanelHostedTabs, type TerminalPanelTab } from "./terminal-panel-tabs.tsx";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const tagName = defineTestTerminalPanelElement(createGhosttyTerminalMock);

async function mount(embedded = true, tabsInHeader = true) {
  let sequence = 0;
  let nextOpen:
    | ReturnType<typeof createDeferred<ReturnType<typeof terminalOpenResult>>>
    | undefined;
  const client: TerminalGatewayClient = {
    forceReconnect: () => {},
    request: async <T>(method: string) => {
      if (method === "terminal.open") {
        const reply = nextOpen;
        nextOpen = undefined;
        const immediate = terminalOpenResult(`session-${++sequence}`);
        return (reply ? await reply.promise : immediate) as T;
      }
      return (method === "terminal.list" ? { sessions: [] } : {}) as T;
    },
    addEventListener: () => () => {},
  };
  const panel = createTestTerminalPanel(tagName);
  panel.available = true;
  panel.embedded = embedded;
  panel.tabsInHeader = tabsInHeader;
  panel.client = client;
  document.body.append(panel);
  if (!embedded) {
    panel.toggle();
  }
  await panel.updateComplete;
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  await panel.updateComplete;
  return {
    panel,
    deferNextOpen: () => {
      nextOpen = createDeferred<ReturnType<typeof terminalOpenResult>>();
      return nextOpen;
    },
  };
}

function mountActions(panel: OpenClawTerminalPanel) {
  const container = document.createElement("div");
  document.body.append(container);
  const update = () => {
    const actions = panel.hostedActions;
    if (actions) {
      if (container.firstChild !== actions) {
        container.replaceChildren(actions);
      }
    } else {
      container.replaceChildren();
    }
  };
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

  afterEach(async () => {
    // This fixture has no destination panel to consume a queued docking handoff.
    for (const panel of document.querySelectorAll<OpenClawTerminalPanel>(tagName)) {
      panel.closeTerminalPanel();
    }
    document.body.replaceChildren();
    await Promise.resolve();
    createGhosttyTerminalMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([{ embedded: false, tabsInHeader: true, ownsStrip: true }])(
    "keeps its own chrome=$ownsStrip for embedded=$embedded and tabsInHeader=$tabsInHeader",
    async ({ embedded, tabsInHeader, ownsStrip }) => {
      const { panel } = await mount(embedded, tabsInHeader);
      expect(Boolean(panel.querySelector(".tp-header"))).toBe(ownsStrip);
      expect(Boolean(panel.querySelector(".tp-actions"))).toBe(ownsStrip);
      expect(panel.querySelector(".tp-viewport")).not.toBeNull();
      expect(panel.querySelector(".tp-file-input")).not.toBeNull();
      const viewport = panel.querySelector(".tp-viewport")!;
      const selectedTab = panel.querySelector('.tabstrip-tab[aria-selected="true"]');
      expect(viewport.getAttribute("aria-labelledby")).toBe(ownsStrip ? selectedTab?.id : null);
      if (ownsStrip) {
        expect(selectedTab).not.toBeNull();
        expect(selectedTab?.getAttribute("aria-controls")).toBe(viewport.id);
        expect(document.getElementById(viewport.getAttribute("aria-labelledby")!)).toBe(
          selectedTab,
        );
      }
      expect(panel.hostedActions === undefined).toBe(ownsStrip);
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
    expect(
      tabs.map(({ id, label, title, statusLabel, badge, className }) => [
        id,
        label,
        title,
        statusLabel,
        badge,
        className,
      ]),
    ).toEqual([
      ["live", "zsh", "ops · /work/ops", null, null, "is-live"],
      ["connecting", "shell 2", null, "Connecting to session…", null, "is-connecting"],
      ["exited", "zsh", "ops · /work/ops", "exited (3)", null, "is-exited"],
      ["agent", "zsh", "ops · /work/ops", null, "agent", "is-live"],
    ]);
  });

  it("selects and closes through the session owner and resolves close after rendering", async () => {
    const { panel } = await mount();
    panel.handleToggleRequest(
      new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
        detail: { open: true, newSession: true },
      }),
    );
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() =>
      expect(panel.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true),
    );
    const firstId = panel.hostedTabs[0]!.id;
    const closedHost = createGhosttyTerminalMock.mock.calls[0]![0].parent;
    const remainingHost = createGhosttyTerminalMock.mock.calls[1]![0].parent;
    panel.selectHostedTab(firstId);
    expect(panel.activeHostedTabId).toBe(firstId);
    await panel.closeHostedTab(firstId);
    expect(panel.hostedTabs.some((tab) => tab.id === firstId)).toBe(false);
    expect(panel.contains(closedHost)).toBe(false);
    expect(panel.contains(remainingHost)).toBe(true);
  });

  it("notifies on tab, selection, booting and header handoff changes, without repeating unrelated renders", async () => {
    const { panel, deferNextOpen } = await mount();
    const firstId = panel.activeHostedTabId!;
    const reply = deferNextOpen();
    const changed = vi.fn();
    document.body.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    try {
      panel.handleToggleRequest(
        new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
          detail: { open: true, newSession: true },
        }),
      );
      await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
      await panel.updateComplete;
      expect(panel.hostedTabs[1]?.className).toBe("is-connecting");
      expect(changed).toHaveBeenCalled();
      expect(changed.mock.calls[0]?.[0]).toMatchObject({
        target: panel,
        bubbles: true,
        composed: true,
      });
      const openingCount = changed.mock.calls.length;
      reply.resolve({ ...terminalOpenResult("session-2"), shell: "/bin/bash" });
      await waitForFast(() =>
        expect(panel.hostedTabs[1]).toMatchObject({ label: "bash", className: "is-live" }),
      );
      await panel.updateComplete;
      expect(changed.mock.calls.length).toBeGreaterThan(openingCount);
      const readyCount = changed.mock.calls.length;
      panel.selectHostedTab(firstId);
      await panel.updateComplete;
      expect(changed.mock.calls.length).toBeGreaterThan(readyCount);
      const stableCount = changed.mock.calls.length;
      panel.themeMode = "light";
      await panel.updateComplete;
      panel.themeMode = "dark";
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(stableCount);
      panel.tabsInHeader = false;
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(stableCount + 1);
      panel.tabsInHeader = true;
      await panel.updateComplete;
      expect(changed).toHaveBeenCalledTimes(stableCount + 2);
    } finally {
      reply.resolve(terminalOpenResult("session-2"));
      document.body.removeEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    }
  });

  it("opens another shell for an explicit new-session toggle", async () => {
    const { panel } = await mount();
    panel.handleToggleRequest(
      new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
        detail: { open: true, newSession: true },
      }),
    );
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() =>
      expect(panel.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true),
    );
    await panel.updateComplete;
  });

  it("offers three light-DOM actions with upload availability", async () => {
    const { panel } = await mount();
    const actions = mountActions(panel);
    expect(
      [...actions.querySelectorAll("button")].map((control) => control.getAttribute("aria-label")),
    ).toEqual(["Terminal sessions", "Add files to terminal", "Dock to bottom"]);
    expect(actions.querySelectorAll("openclaw-tooltip > .rail-header__action")).toHaveLength(3);
    expect(actions.querySelector('[class*="tp-"]')).toBeNull();
    const inputClick = vi.spyOn(panel.querySelector<HTMLInputElement>(".tp-file-input")!, "click");
    button(actions, "Add files to terminal").click();
    expect(inputClick).toHaveBeenCalledOnce();
    expect(button(actions, "Add files to terminal").disabled).toBe(false);
    const read = createDeferred<ArrayBuffer>();
    const file = new File(["synthetic"], "pending.txt");
    Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
    const input = panel.querySelector<HTMLInputElement>(".tp-file-input")!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await panel.updateComplete;
    expect(button(actions, "Add files to terminal").disabled).toBe(true);
    panel.querySelector<HTMLButtonElement>(".tp-upload-cancel")!.click();
    read.resolve(new ArrayBuffer(0));
    await read.promise;
    await panel.updateComplete;
    expect(button(actions, "Add files to terminal").disabled).toBe(false);
    const dock = vi.fn();
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    try {
      const dockButton = button(actions, "Dock to bottom");
      dockButton.click();
      expect(dock.mock.calls[0]?.[0].detail).toMatchObject({ dock: "bottom", open: true });
      await panel.updateComplete;
      expect(panel.hostedTabs).toHaveLength(0);
      expect(button(actions, "Add files to terminal").disabled).toBe(true);
      panel.closeTerminalPanel();
      panel.remove();
      await Promise.resolve();
      dockButton.click();
      expect(dock).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    }
  });

  it("opens its panel menu from the hosted header and restores focus on Escape", async () => {
    const { panel } = await mount();
    const actions = mountActions(panel);
    const trigger = button(actions, "Terminal sessions");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    trigger.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(panel.querySelector(".tp-session-refresh")),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = panel.querySelector(".tp-session-menu.tp-session-menu--hosted")!;
    expect(menu).not.toBeNull();
    expect(actions.querySelector(".tp-session-menu")).toBeNull();
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBe(menu);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await panel.updateComplete;
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
  });
});
