/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createInitializationContext } from "../../pages/chat/chat-pane.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as confirmation from "../confirm-dialog.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, readPanelHostedTabs } from "../panel-hosted-tabs.ts";
import { TERMINAL_PANEL_DOCK_BOTTOM_EVENT } from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  mountPanel,
  panelButton,
  panelTestStorage,
  togglePanel,
} from "./terminal-panel-lifecycle.test-support.ts";
import { terminalPanelHostedTabs, type TerminalPanelTab } from "./terminal-panel-tabs.tsx";
import {
  createTerminalController,
  createTerminalGatewayClient,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const tagName = defineTestTerminalPanelElement(createGhosttyTerminalMock);
panelTestStorage(
  createGhosttyTerminalMock,
  false,
  () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    return i18n.setLocale("en");
  },
  () => {
    // No destination panel consumes this fixture's queued docking handoff.
    for (const panel of document.querySelectorAll<OpenClawTerminalPanel>(tagName)) {
      panel.closeTerminalPanel();
    }
  },
);

async function mount(embedded = true, tabsInHeader = true) {
  let sequence = 0;
  let nextOpen:
    | ReturnType<typeof createDeferred<ReturnType<typeof terminalOpenResult>>>
    | undefined;
  const client: TerminalGatewayClient = createTerminalGatewayClient(async <T>(method: string) => {
    if (method === "terminal.open") {
      const reply = nextOpen;
      nextOpen = undefined;
      const immediate = terminalOpenResult(`session-${++sequence}`);
      return (reply ? await reply.promise : immediate) as T;
    }
    return (method === "terminal.list" ? { sessions: [] } : { ok: true }) as T;
  });
  const panel = mountPanel(tagName, { available: true, embedded, tabsInHeader, client }, !embedded);
  await panel.updateComplete;
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  await panel.updateComplete;
  return {
    panel,
    client,
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
  beforeEach(() => {
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
  });

  it.each(["reconnect", "context replacement"] as const)(
    "settles queued header changes and restores a live terminal after %s",
    async (transition) => {
      const oldController = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValueOnce(oldController);
      const session = terminalOpenResult("retained-session");
      const client = createPickerClient(true, session, false);
      const first = createInitializationContext();
      const provider = createApplicationContextProvider(first);
      const panel = createTestTerminalPanel(tagName);
      panel.client = client;
      panel.available = panel.embedded = panel.tabsInHeader = true;
      provider.append(panel);
      document.body.append(provider);
      // The native bridge has not attached its presentation yet.
      panel.toggle();
      await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
      await panel.updateComplete;
      const oldViewport = panel.querySelector(".tp-viewport");

      panel.tabsInHeader = false;
      const pending = panel.updateComplete;
      if (transition === "reconnect") {
        panel.remove();
        await pending;
        provider.append(panel);
      } else {
        provider.setContext({ ...first, basePath: "/replacement" });
        await pending;
      }
      await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
      await panel.updateComplete;
      expect(oldController.dispose).toHaveBeenCalledOnce();
      expect(panel.querySelector(".tp-viewport")).not.toBe(oldViewport);
      expect(panel.querySelector(".tp-header")).not.toBeNull();
      const terminalHost = createGhosttyTerminalMock.mock.calls[1]![0].parent;
      expect(panel.contains(terminalHost)).toBe(true);
      expect(terminalHost.style.display).toBe("block");

      panel.tabsInHeader = true;
      await panel.updateComplete;
      expect(panel.querySelector(".tp-header")).toBeNull();
      expect(panel.hostedTabs).toHaveLength(1);
      expect(panel.contains(terminalHost)).toBe(true);
    },
  );

  it("keeps its own accessible chrome when not embedded", async () => {
    const { panel } = await mount(false);
    expect(panel.querySelector(".tp-header")).not.toBeNull();
    expect(panel.querySelector(".tp-actions")).not.toBeNull();
    expect(panel.querySelector(".tp-viewport")).not.toBeNull();
    expect(panel.querySelector(".tp-file-input")).not.toBeNull();
    const viewport = panel.querySelector(".tp-viewport")!;
    const selectedTab = panel.querySelector('.tabstrip-tab[aria-selected="true"]');
    expect(viewport.getAttribute("aria-labelledby")).toBe(selectedTab?.id);
    expect(selectedTab).not.toBeNull();
    expect(selectedTab?.getAttribute("aria-controls")).toBe(viewport.id);
    expect(document.getElementById(viewport.getAttribute("aria-labelledby")!)).toBe(selectedTab);
    expect(panel.hostedActions).toBeUndefined();
    expect(readPanelHostedTabs(panel)).toBe(panel);
  });

  it("projects shell labels, status, workspace hints, and agent ownership for either strip", () => {
    const base: TerminalPanelTab = {
      id: "live",
      sequence: 1,
      shellName: "zsh",
      agentId: "ops",
      cwd: "/work/ops",
      status: "live",
    };
    const tabs = terminalPanelHostedTabs(
      [
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
      ],
      true,
    );
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
    togglePanel(panel, { open: true, newSession: true });
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
      togglePanel(panel, { open: true, newSession: true });
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

  it("keeps mobile docking hosted and routes upload through the embedded composer", async () => {
    const { panel } = await mount();
    panel.mobile = true;
    await panel.updateComplete;
    const actions = mountActions(panel);
    expect(
      [...actions.querySelectorAll("button")].map((control) => control.getAttribute("aria-label")),
    ).toEqual(["Dock to bottom"]);
    expect(actions.querySelectorAll("openclaw-tooltip > .rail-header__action")).toHaveLength(1);
    expect(actions.querySelector('[class*="tp-"]')).toBeNull();
    panel.selectHostedTab(panel.activeHostedTabId!);
    await panel.updateComplete;
    const inputClick = vi.spyOn(panel.querySelector<HTMLInputElement>(".tp-file-input")!, "click");
    button(panel, "Add files to terminal").click();
    expect(inputClick).toHaveBeenCalledOnce();
    expect(button(panel, "Add files to terminal").disabled).toBe(false);
    const read = createDeferred<ArrayBuffer>();
    const file = new File(["synthetic"], "pending.txt");
    Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
    const input = panel.querySelector<HTMLInputElement>(".tp-file-input")!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await panel.updateComplete;
    expect(button(panel, "Add files to terminal").disabled).toBe(true);
    panel.querySelector<HTMLButtonElement>(".tp-upload-cancel")!.click();
    read.resolve(new ArrayBuffer(0));
    await read.promise;
    await panel.updateComplete;
    expect(button(panel, "Add files to terminal").disabled).toBe(false);
    const dock = vi.fn();
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    try {
      const dockButton = button(actions, "Dock to bottom");
      dockButton.click();
      expect(dock.mock.calls[0]?.[0].detail).toMatchObject({ dock: "bottom", open: true });
      await panel.updateComplete;
      expect(panel.hostedTabs).toHaveLength(0);
      expect(panel.querySelector(".tp-composer")).toBeNull();
      panel.closeTerminalPanel();
      panel.remove();
      await Promise.resolve();
      dockButton.click();
      expect(dock).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, dock);
    }
  });

  it("keeps mobile Sessions internal and returns focus on Escape", async () => {
    const { panel } = await mount();
    panel.mobile = true;
    await panel.updateComplete;
    button(panel, "Terminal sessions").click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(panel.querySelector(".tp-session-refresh")),
    );
    const menu = panel.querySelector(".tp-session-menu--inline")!;
    expect(menu.getAttribute("role")).toBe("region");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu--inline")).toBe(menu);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    await waitForFast(() =>
      expect(document.activeElement).toBe(button(panel, "Terminal sessions")),
    );
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
    expect(panel.hostedTabs).toHaveLength(1);
  });

  it("cancels closing a live personal terminal without ending its session", async () => {
    const { panel, client } = await mount();
    panel.mobile = true;
    await panel.updateComplete;
    const request = vi.spyOn(client, "request");
    const id = panel.activeHostedTabId!;
    const closing = panel.closeHostedTab(id);
    await waitForFast(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (control) => control.textContent?.trim() === "Cancel",
    );
    expect(cancel).toBeDefined();
    cancel!.click();
    await closing;
    expect(panel.activeHostedTabId).toBe(id);
    expect(panel.hostedTabs).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
  });

  it("keeps a mobile terminal open and shows a rejected close confirmation", async () => {
    const { panel, client } = await mount();
    panel.mobile = true;
    await panel.updateComplete;
    const request = vi.spyOn(client, "request");
    const failure = new Error("Close confirmation unavailable. Try again.");
    vi.spyOn(confirmation, "showConfirmDialog").mockRejectedValueOnce(failure);
    const id = panel.activeHostedTabId!;
    await panel.closeHostedTab(id);
    await waitForFast(() => expect(panel.textContent).toContain(failure.message));
    expect(panel.activeHostedTabId).toBe(id);
    expect(panel.hostedTabs).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
  });
});

function createPanel(client: TerminalGatewayClient, embedded = false) {
  return mountPanel(tagName, { client, available: true, embedded }, !embedded);
}

function createPickerClient(
  listCurrent: boolean | (() => boolean) = false,
  session = terminalOpenResult("current-1"),
  attached = true,
) {
  return createTerminalGatewayClient(
    async <T>(method: string) =>
      (method === "terminal.open"
        ? session
        : method === "terminal.attach"
          ? { ...session, buffer: "", seq: 0 }
          : method === "terminal.list"
            ? {
                sessions: (typeof listCurrent === "function" ? listCurrent() : listCurrent)
                  ? [{ ...session, attached, createdAtMs: 1 }]
                  : [],
              }
            : { ok: true }) as T,
  ) satisfies TerminalGatewayClient;
}

describe("OpenClawTerminalPanel accessibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
  });

  it("offers bottom docking from an embedded terminal", async () => {
    const event = vi.fn();
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, event);
    const panel = createTestTerminalPanel(tagName);
    panel.client = createPickerClient();
    panel.available = true;
    panel.agentId = "main";
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;
    const dock = button(panel, "Dock to bottom");
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
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 320, width: 520 }),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const panel = createTestTerminalPanel(tagName);
    panel.client = createPickerClient();
    panel.available = true;
    document.body.append(panel);
    panel.basePath = "/openclaw";
    await waitForFast(() =>
      expect(panel.querySelector('[aria-label="Open terminal in new window"]')).not.toBeNull(),
    );

    button(panel, "Open terminal in new window").click();

    expect(open).toHaveBeenCalledWith(
      "http://localhost:3000/openclaw/focus/terminal",
      "_blank",
      "noopener,noreferrer",
    );

    panel.fullscreen = true;
    await panel.updateComplete;
    expect(panel.querySelector('[aria-label="Open terminal in new window"]')).toBeNull();
    open.mockRestore();
  });

  it("keeps tab and session-picker references inside each split terminal", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const panel = createPanel(createPickerClient(true), true);
      await waitForFast(() =>
        expect(panel.querySelector('.tabstrip-tab[aria-selected="true"]')).not.toBeNull(),
      );
      const viewport = panel.querySelector(".tp-viewport")!;
      const selectedTab = panel.querySelector('.tabstrip-tab[aria-selected="true"]')!;
      expect(document.getElementById(selectedTab.getAttribute("aria-controls")!)).toBe(viewport);
      expect(document.getElementById(viewport.getAttribute("aria-labelledby")!)).toBe(selectedTab);

      expect(panel.querySelector(".tp-session-menu")?.getAttribute("role")).toBe("region");
      await waitForFast(() => expect(panel.querySelector(".tp-session.is-current")).not.toBeNull());
      panelButton(panel, ".tp-session.is-current")!.click();
      await panel.updateComplete;
      expect(panel.querySelector(".tp-session-menu")).toBeNull();
      const trigger = button(panel, "Terminal sessions");
      trigger.click();
      await waitForFast(() => expect(panel.querySelector(".tp-session-menu")).not.toBeNull());
      const menu = panel.querySelector(".tp-session-menu")!;
      expect(document.getElementById(menu.id)).toBe(menu);
      expect(viewport.getAttribute("aria-hidden")).toBe("true");
      ids.push(viewport.id, selectedTab.id, menu.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps trigger focus inside the picker and dismisses after focus leaves", async () => {
    const panel = createPanel(createPickerClient());
    await waitForFast(() => expect(panel.querySelector(".tp-actions")).not.toBeNull());

    const trigger = button(panel, "Terminal sessions");
    trigger.click();
    await waitForFast(() => expect(panel.querySelector(".tp-session-menu")).not.toBeNull());
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    trigger.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    trigger.click();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBeNull();

    trigger.click();
    await waitForFast(() =>
      expect(document.activeElement).toBe(panel.querySelector(".tp-session-refresh")),
    );
    trigger.focus();
    await Promise.resolve();
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
  });

  it("discovers dock sessions and retires an open picker when only its current session remains", async () => {
    let onlyCurrent = true;
    const client = createPickerClient(() => onlyCurrent);
    const request = vi.spyOn(client, "request");
    const panel = createPanel(client);
    const trigger = () => panelButton(panel, '[aria-label="Terminal sessions"]');
    await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
    await waitForFast(() => expect(trigger()).toBeNull());
    expect(request.mock.calls.some(([method]) => method === "terminal.list")).toBe(true);

    onlyCurrent = false;
    window.dispatchEvent(new Event("focus"));
    await waitForFast(() => expect(trigger()).not.toBeNull());
    const removedTrigger = trigger()!;
    const restoreFocus = vi.spyOn(removedTrigger, "focus");
    removedTrigger.click();
    await waitForFast(() => expect(panel.querySelector(".tp-session-menu")).not.toBeNull());
    onlyCurrent = true;
    panelButton(panel, ".tp-session-refresh")!.click();
    await waitForFast(() => expect(trigger()).toBeNull());
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
    expect(restoreFocus).not.toHaveBeenCalled();

    onlyCurrent = false;
    window.dispatchEvent(new Event("focus"));
    await waitForFast(() => expect(trigger()).not.toBeNull());
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    const listReads = request.mock.calls.filter(([method]) => method === "terminal.list").length;
    panel.themeMode = "light";
    await panel.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "terminal.list")).toHaveLength(
      listReads,
    );
  });

  it("keeps pointer actions inside the terminal session picker", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string, params?: unknown) => {
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
        return { ok: true } as T;
      },
    );
    const panel = createPanel(client);
    await waitForFast(() => expect(panel.querySelector(".tp-actions")).not.toBeNull());

    const trigger = button(panel, "Terminal sessions");
    trigger.click();
    await waitForFast(() =>
      expect(panel.querySelector(".tp-session")?.textContent).toContain("detached-agent"),
    );

    const refresh = panelButton(panel, ".tp-session-refresh")!;
    refresh.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    refresh.click();
    await waitForFast(() => {
      expect(requests.filter(({ method }) => method === "terminal.list")).toHaveLength(3);
    });
    await waitForFast(() =>
      expect(panel.querySelector(".tp-session")?.textContent).toContain("detached-agent"),
    );

    const attach = panelButton(panel, ".tp-session")!;
    attach.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    attach.click();
    await waitForFast(() =>
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "detached-1" },
      }),
    );
  });
});
