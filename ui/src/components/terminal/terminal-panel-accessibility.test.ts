/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { TERMINAL_PANEL_DOCK_BOTTOM_EVENT } from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

function createPanel(client: TerminalGatewayClient, embedded = false) {
  const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
  panel.client = client;
  panel.available = true;
  panel.embedded = embedded;
  document.body.append(panel);
  if (!embedded) {
    panel.toggle();
  }
  return panel;
}

function createPickerClient() {
  return {
    forceReconnect: () => {},
    request: async <T>(method: string) =>
      (method === "terminal.open"
        ? terminalOpenResult("current-1")
        : method === "terminal.list"
          ? { sessions: [] }
          : {}) as T,
    addEventListener: () => () => {},
  } satisfies TerminalGatewayClient;
}

describe("OpenClawTerminalPanel accessibility", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    await i18n.setLocale("en");
  });

  it("labels the placement switcher with the alternative destinations only", async () => {
    const panel = createPanel(createPickerClient());
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-actions")).not.toBeNull());

    // The occupied dock (bottom by default) has nowhere to move to, so its
    // button drops out of the cluster instead of rendering a pressed state.
    const switcher = panel.renderRoot.querySelector('.tp-actions [role="group"]');
    expect(switcher?.getAttribute("aria-label")).toBe("Terminal panel position");
    expect(
      ["Dock to right", "Fill main content area"].every((label) =>
        switcher?.querySelector(`[aria-label="${label}"]`),
      ),
    ).toBe(true);
    expect(switcher?.querySelector('[aria-label="Dock to bottom"]')).toBeNull();
  });

  it("offers bottom docking from an embedded terminal", async () => {
    const event = vi.fn();
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, event);
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = createPickerClient();
    panel.available = true;
    panel.agentId = "main";
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;
    const dock = panel.renderRoot.querySelector<HTMLButtonElement>(
      '[aria-label="Dock to bottom"]',
    )!;
    await waitForFast(() => {
      expect(panel.hostedTabs[0]?.className).toBe("is-live");
      expect(dock.disabled).toBe(false);
    });
    dock.click();

    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { agentId: "main", dock: "bottom", open: true } }),
    );
    window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, event);
  });

  it("opens the base-mounted focused terminal in an isolated tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const panel = createPanel(createPickerClient());
    panel.basePath = "/openclaw";
    await waitForFast(() =>
      expect(
        panel.renderRoot.querySelector('[aria-label="Open terminal in new window"]'),
      ).not.toBeNull(),
    );

    panel.renderRoot
      .querySelector<HTMLButtonElement>('[aria-label="Open terminal in new window"]')
      ?.click();

    expect(open).toHaveBeenCalledWith(
      "http://localhost:3000/openclaw/focus/terminal",
      "_blank",
      "noopener,noreferrer",
    );

    panel.fullscreen = true;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector('[aria-label="Open terminal in new window"]')).toBeNull();
    open.mockRestore();
  });

  afterEach(async () => {
    for (const panel of document.querySelectorAll<OpenClawTerminalPanel>(
      TERMINAL_PANEL_ELEMENT_NAME,
    )) {
      panel.closeTerminalPanel();
    }
    document.body.replaceChildren();
    await Promise.resolve();
    localStorage.clear();
    sessionStorage.clear();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("manages focus and dismissal for the terminal session picker", async () => {
    const panel = createPanel(createPickerClient());
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-actions")).not.toBeNull());

    const trigger = panel.renderRoot.querySelector<HTMLButtonElement>(
      '[aria-label="Terminal sessions"]',
    );
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger?.getAttribute("aria-controls")).toBeTruthy();

    trigger?.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(panel.renderRoot.querySelector(".tp-session-refresh")),
    );
    const menu = panel.renderRoot.querySelector(".tp-session-menu")!;
    expect(menu.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(trigger!.getAttribute("aria-controls")!)).toBe(menu);

    panel.renderRoot
      .querySelector(".tp-session-refresh")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger?.click();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull(),
    );
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();
  });

  it("keeps tab and session-picker references inside each split terminal", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const panel = createPanel(createPickerClient(), true);
      await waitForFast(() =>
        expect(
          panel.renderRoot.querySelector('.tabstrip-tab[aria-selected="true"]'),
        ).not.toBeNull(),
      );
      const viewport = panel.renderRoot.querySelector(".tp-viewport")!;
      const selectedTab = panel.renderRoot.querySelector('.tabstrip-tab[aria-selected="true"]')!;
      expect(document.getElementById(selectedTab.getAttribute("aria-controls")!)).toBe(viewport);
      expect(document.getElementById(viewport.getAttribute("aria-labelledby")!)).toBe(selectedTab);

      const trigger = panel.renderRoot.querySelector<HTMLButtonElement>(
        '[aria-label="Terminal sessions"]',
      )!;
      trigger.click();
      await waitForFast(() =>
        expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull(),
      );
      const menu = panel.renderRoot.querySelector(".tp-session-menu")!;
      expect(document.getElementById(trigger.getAttribute("aria-controls")!)).toBe(menu);
      ids.push(viewport.id, selectedTab.id, menu.id);
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await panel.updateComplete;
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps trigger focus inside the picker and dismisses after focus leaves", async () => {
    const panel = createPanel(createPickerClient());
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-actions")).not.toBeNull());

    const trigger = panel.renderRoot.querySelector<HTMLButtonElement>(
      '[aria-label="Terminal sessions"]',
    )!;
    trigger.click();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull(),
    );
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    trigger.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull();
    trigger.click();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();

    trigger.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(panel.renderRoot.querySelector(".tp-session-refresh")),
    );
    trigger.focus();
    await Promise.resolve();
    expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp-session-menu")).toBeNull();
  });

  it("keeps shadow-DOM pointer actions inside the terminal session picker", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          return terminalOpenResult("current-1") as T;
        }
        if (method === "terminal.list") {
          return {
            sessions: [
              {
                ...terminalOpenResult("detached-1"),
                agentId: "detached-agent",
                attached: false,
                createdAtMs: 1,
              },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("detached-1"),
            agentId: "detached-agent",
            buffer: "",
            seq: 0,
          } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = createPanel(client);
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-actions")).not.toBeNull());

    const trigger = panel.renderRoot.querySelector<HTMLButtonElement>(
      '[aria-label="Terminal sessions"]',
    )!;
    trigger.click();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".tp-session")?.textContent).toContain(
        "detached-agent",
      ),
    );

    const refresh = panel.renderRoot.querySelector<HTMLButtonElement>(".tp-session-refresh")!;
    refresh.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull();
    refresh.click();
    await waitForFast(() => {
      expect(requests.filter(({ method }) => method === "terminal.list")).toHaveLength(2);
    });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".tp-session")?.textContent).toContain(
        "detached-agent",
      ),
    );

    const attach = panel.renderRoot.querySelector<HTMLButtonElement>(".tp-session")!;
    attach.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.renderRoot.querySelector(".tp-session-menu")).not.toBeNull();
    attach.click();
    await waitForFast(() =>
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "detached-1" },
      }),
    );
  });
});
