/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createInitializationContext } from "../../pages/chat/chat-application-context.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as confirmation from "../confirm-dialog.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT } from "../panel-hosted-tabs.ts";
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
const TERMINAL_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
type SessionReply = ReturnType<typeof terminalOpenResult>;
panelTestStorage(
  createGhosttyTerminalMock,
  false,
  () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  },
  () => {
    // No destination panel consumes this fixture's queued docking handoff.
    for (const panel of document.querySelectorAll<OpenClawTerminalPanel>(tagName)) {
      panel.closeTerminalPanel();
    }
  },
);

async function mount(props: Partial<OpenClawTerminalPanel> = {}) {
  let sequence = 0;
  let nextOpen: ReturnType<typeof createDeferred<SessionReply>> | undefined;
  const client: TerminalGatewayClient = createTerminalGatewayClient(async <T>(method: string) => {
    if (method === "terminal.open") {
      const reply = nextOpen;
      nextOpen = undefined;
      const immediate = terminalOpenResult(`session-${++sequence}`);
      return (reply ? await reply.promise : immediate) as T;
    }
    return (method === "terminal.list" ? { sessions: [] } : { ok: true }) as T;
  });
  const panel = mountPanel(
    tagName,
    {
      available: true,
      embedded: true,
      tabsInHeader: true,
      client,
      ...props,
    },
    false,
  );
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  await panel.updateComplete;
  return {
    panel,
    client,
    deferNextOpen: () => {
      nextOpen = createDeferred<SessionReply>();
      return nextOpen;
    },
  };
}

function mountActions(panel: OpenClawTerminalPanel) {
  const container = document.body.appendChild(document.createElement("div"));
  const update = () => {
    const actions = panel.hostedActions;
    if (container.firstChild !== actions) {
      container.replaceChildren(...(actions ? [actions] : []));
    }
  };
  panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, update);
  update();
  return container;
}

function button(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
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

  it("projects shell labels, status, workspace hints, and agent ownership for either strip", () => {
    const base: TerminalPanelTab = {
      id: "live",
      sequence: 1,
      shellName: "zsh",
      agentId: "ops",
      cwd: "/work/ops",
      status: "live",
    };
    const tab = (overrides: Partial<TerminalPanelTab>) => ({ ...base, ...overrides });
    const tabs = terminalPanelHostedTabs(
      [
        base,
        tab({ sequence: 2, shellName: null, status: "connecting", agentId: null }),
        tab({ status: "exited", exitReason: "process_exit", exitCode: 3 }),
        tab({ agentOwned: true }),
      ],
      true,
    );
    expect(tabs.map((entry) => [entry.label, entry.title, entry.statusLabel, entry.badge])).toEqual(
      [
        ["zsh", "ops · /work/ops", null, null],
        ["shell 2", null, "Connecting to session…", null],
        ["zsh", "ops · /work/ops", "exited (3)", null],
        ["zsh", "ops · /work/ops", null, "agent"],
      ],
    );
  });

  it("notifies on tab, selection, booting and header handoff changes, without repeating unrelated renders", async () => {
    const { panel, deferNextOpen } = await mount();
    const firstId = panel.activeHostedTabId!;
    const closedHost = createGhosttyTerminalMock.mock.calls[0]![0].parent;
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
      expect(panel.activeHostedTabId).toBe(firstId);
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
      await panel.closeHostedTab(firstId);
      expect(panel.hostedTabs.some((tab) => tab.id === firstId)).toBe(false);
      expect(panel.contains(closedHost)).toBe(false);
      expect(panel.contains(createGhosttyTerminalMock.mock.calls[1]![0].parent)).toBe(true);
    } finally {
      reply.resolve(terminalOpenResult("session-2"));
      document.body.removeEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);
    }
  });

  it("keeps mobile docking hosted and routes upload through the embedded composer", async () => {
    const { panel } = await mount({ mobile: true, agentId: "main" });
    const actions = mountActions(panel);
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
      expect(dock.mock.calls[0]?.[0].detail).toEqual({
        agentId: "main",
        dock: "bottom",
        open: true,
      });
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
    const { panel } = await mount({ mobile: true });
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

  it.each(["cancel", "reject"] as const)(
    "keeps a live terminal after %s confirmation",
    async (outcome) => {
      const { panel, client } = await mount({ mobile: true });
      const request = vi.spyOn(client, "request");
      const failure = new Error("Close confirmation unavailable. Try again.");
      if (outcome === "reject") {
        vi.spyOn(confirmation, "showConfirmDialog").mockRejectedValueOnce(failure);
      }
      const id = panel.activeHostedTabId!;
      const closing = panel.closeHostedTab(id);
      if (outcome === "cancel") {
        await waitForFast(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        const cancel = [
          ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
        ].find((control) => control.textContent?.trim() === "Cancel");
        expect(cancel).toBeDefined();
        cancel!.click();
      }
      await closing;
      if (outcome === "reject") {
        await waitForFast(() => expect(panel.textContent).toContain(failure.message));
      }
      expect(panel.activeHostedTabId).toBe(id);
      expect(panel.hostedTabs).toHaveLength(1);
      expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
    },
  );
});

function createPanel(client: TerminalGatewayClient, embedded = false) {
  return mountPanel(tagName, { client, available: true, embedded }, !embedded);
}

function createPickerClient(
  listCurrent: boolean | (() => boolean) = false,
  session = terminalOpenResult("current-1"),
  attached = true,
  openSessionId = session.sessionId,
) {
  return createTerminalGatewayClient(
    async <T>(method: string) =>
      (method === "terminal.open"
        ? terminalOpenResult(openSessionId)
        : method === "terminal.attach"
          ? { ...session, buffer: "", seq: 0 }
          : method === "terminal.list"
            ? (typeof listCurrent === "function" ? listCurrent() : listCurrent)
              ? { sessions: [{ ...session, attached, createdAtMs: 1 }] }
              : {}
            : { ok: true }) as T,
  ) satisfies TerminalGatewayClient;
}

describe("OpenClawTerminalPanel accessibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
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
    expect(panel.hostedActions).toBeUndefined();
    await waitForFast(() =>
      expect(panel.querySelector('[aria-label="Open terminal in new window"]')).not.toBeNull(),
    );
    expect(panel.querySelector(".tp-header")).not.toBeNull();

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
      expect(button(panel, "Dock to bottom").disabled).toBe(false);
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

  it("keeps picker pointer and focus actions inside until focus leaves", async () => {
    const detached = { ...terminalOpenResult("detached-1"), agentId: "detached-agent" };
    let listed = false;
    const client = createPickerClient(() => listed, detached, false, "current-1");
    const request = vi.spyOn(client, "request");
    const panel = createPanel(client);
    await waitForFast(() => expect(panel.querySelector(".tp-actions")).not.toBeNull());

    const trigger = button(panel, "Terminal sessions");
    trigger.click();
    await waitForFast(() => expect(panel.querySelector(".tp-session-menu")).not.toBeNull());
    await waitForFast(() => expect(panel.querySelector(".tp-session-empty")).not.toBeNull());
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    trigger.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    listed = true;
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

    const refresh = panelButton(panel, ".tp-session-refresh")!;
    refresh.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    request.mockClear();
    refresh.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("terminal.list"));
    await waitForFast(() =>
      expect(panel.querySelector(".tp-session")?.textContent).toContain("detached-agent"),
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await Promise.resolve();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
    trigger.click();
    await waitForFast(() => expect(panel.querySelector(".tp-session")).not.toBeNull());
    const attach = panelButton(panel, ".tp-session")!;
    attach.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(panel.querySelector(".tp-session-menu")).not.toBeNull();
    attach.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("terminal.attach", { sessionId: "detached-1" }),
    );
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
});

function terminalUploadFile(name: string, content: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

async function mountReadyPanel(client: TerminalGatewayClient) {
  const panel = mountPanel(tagName, { client, available: true }, false);
  panel.toggle();
  await waitForFast(() => expect(panelButton(panel, ".tp-upload")?.disabled).toBe(false));
  return panel;
}

function uploadClient(upload: (params: unknown, signal?: AbortSignal) => unknown) {
  return createTerminalGatewayClient(
    async <T>(method: string, params?: unknown, options?: { signal?: AbortSignal }) =>
      (method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.upload"
          ? await upload(params, options?.signal)
          : { ok: true }) as T,
  );
}

function dropFiles(panel: OpenClawTerminalPanel, files: File[]) {
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  panel.querySelector(".tp-viewport")?.dispatchEvent(drop);
}

it("enforces mobile upload policy during pending reads and leaves text drops alone", async () => {
  let enabled = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ uploadsEnabled: enabled }))),
  );
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  await config.refresh();
  const uploadRequest = vi.fn();
  const terminal = createTerminalController();
  createGhosttyTerminalMock.mockResolvedValue(terminal);
  const host = createApplicationContextProvider({ ...createInitializationContext(), config });
  const panel = Object.assign(createTestTerminalPanel(tagName), {
    embedded: true,
    mobile: true,
    available: true,
    client: uploadClient(uploadRequest),
  });
  host.append(panel);
  document.body.append(host);
  await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
  const staleInput = panel.querySelector<HTMLInputElement>(".tp-file-input")!;
  const pending = createDeferred<ArrayBuffer>();
  const pendingFile = new File(["pending"], "pending.txt");
  Object.defineProperty(pendingFile, "arrayBuffer", { value: () => pending.promise });
  dropFiles(panel, [pendingFile]);
  await waitForFast(() => expect(panel.querySelector(".tp-upload-card")).not.toBeNull());
  // Change the owner policy without notifying the renderer: the pending read must recheck it.
  config.current.uploadsEnabled = false;
  pending.resolve(new ArrayBuffer(1));
  await waitForFast(() => expect(panel.querySelector(".tp-upload-card")).toBeNull());
  expect(uploadRequest).not.toHaveBeenCalled();
  expect(terminal.terminal.paste).not.toHaveBeenCalled();
  enabled = false;
  await config.refresh();
  await panel.updateComplete;
  expect(panel.querySelector(".tp-file-input")).toBeNull();
  expect(panel.querySelector(".tp-upload")).toBeNull();
  const read = vi.fn();
  const file = new File(["test"], "test.txt");
  Object.defineProperty(file, "arrayBuffer", { value: read });
  Object.defineProperty(staleInput, "files", { value: [file] });
  staleInput.dispatchEvent(new Event("change"));
  const viewport = panel.querySelector(".tp-viewport")!;
  for (const type of ["dragenter", "dragover", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const transfer = { types: ["Files"], files: [file], dropEffect: "copy" };
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    if (type !== "drop") {
      expect(transfer.dropEffect).toBe("none");
    }
  }
  expect(read).not.toHaveBeenCalled();
  expect(panel.querySelector(".tp-upload-progress")).toBeNull();
  const textDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(textDrop, "dataTransfer", {
    value: { types: ["text/plain"], files: [] },
  });
  viewport.dispatchEvent(textDrop);
  expect(textDrop.defaultPrevented).toBe(false);
  enabled = true;
  await config.refresh();
  await panel.updateComplete;
  expect(panel.querySelector(".tp-file-input")).not.toBeNull();
  expect(panel.querySelector(".tp-upload")).not.toBeNull();
});
it.each(["retry", "expired-retry", "expired-insert", "expired-completion"] as const)(
  "preserves completed upload paths during %s recovery",
  async (recovery) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const uploads: string[] = [];
    const failedUpload = createDeferred<{ path: string; size: number }>();
    let notesAttempts = 0;
    const client = uploadClient((params) => {
      const name = (params as { name: string }).name;
      uploads.push(name);
      if (name === "scan final.pdf") {
        return { path: "/tmp/openclaw upload/scan final.pdf", size: 3 };
      }
      return ++notesAttempts === 1
        ? failedUpload.promise
        : { path: "/tmp/openclaw upload/notes.txt", size: 4 };
    });
    const panel = await mountReadyPanel(client);
    dropFiles(panel, [
      terminalUploadFile("scan final.pdf", "pdf"),
      terminalUploadFile("notes.txt", "note"),
    ]);

    await waitForFast(() => {
      const progress = panel.querySelector(".tp-upload-progress");
      expect(progress?.getAttribute("aria-valuenow")).toBe("1");
      expect(progress?.getAttribute("aria-valuemax")).toBe("2");
      expect(panel.querySelector(".tp-upload-card")?.textContent).toContain("notes.txt");
    });
    expect(controller.terminal.paste).not.toHaveBeenCalled();

    const expectExpiredBatch = async () => {
      await waitForFast(() => {
        expect(panel.querySelector(".tp-upload-card--failed")?.textContent).toMatch(/expired/);
        expect(panel.querySelector(".tp-upload-retry")).toBeNull();
        expect(panel.querySelector(".tp-upload-insert")).toBeNull();
      });
      expect(controller.terminal.paste).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(2);
    };
    if (recovery === "expired-completion") {
      now += TERMINAL_UPLOAD_RETENTION_MS;
      failedUpload.resolve({ path: "/tmp/openclaw upload/notes.txt", size: 4 });
      await expectExpiredBatch();
      return;
    }

    failedUpload.reject(
      Object.assign(new Error("terminal upload staging is full"), {
        gatewayCode: "UNAVAILABLE",
        retryable: false,
      }),
    );
    await waitForFast(() => {
      const failed = panel.querySelector(".tp-upload-card--failed");
      expect(failed?.textContent).toContain("terminal upload staging is full");
      expect(panelButton(panel, ".tp-upload-retry")).not.toBeNull();
      if (recovery === "expired-insert") {
        expect(panelButton(panel, ".tp-upload-insert")).not.toBeNull();
      }
    });

    if (recovery === "expired-retry" || recovery === "expired-insert") {
      now += TERMINAL_UPLOAD_RETENTION_MS;
      panelButton(
        panel,
        recovery === "expired-retry" ? ".tp-upload-retry" : ".tp-upload-insert",
      )?.click();
      await expectExpiredBatch();
      return;
    }
    panelButton(panel, ".tp-upload-retry")?.click();

    await waitForFast(() => {
      expect(controller.terminal.paste).toHaveBeenCalledWith(
        "'/tmp/openclaw upload/scan final.pdf' '/tmp/openclaw upload/notes.txt'",
      );
      expect(panel.querySelector(".tp-upload-card")).toBeNull();
    });
    expect(uploads).toEqual(["scan final.pdf", "notes.txt", "notes.txt"]);
  },
);

it.each(["cancel button", "tab close"] as const)(
  "cancels an active upload through %s without pasting late results",
  async (trigger) => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const pendingUpload = createDeferred<{ path: string; size: number }>();
    let uploadSignal: AbortSignal | undefined;
    const client = uploadClient((_params, signal) => {
      uploadSignal = signal;
      return pendingUpload.promise;
    });
    const panel = await mountReadyPanel(client);
    dropFiles(panel, [terminalUploadFile("archive.zip", "zip")]);
    await waitForFast(() => {
      expect(panel.querySelector(".tp-upload-card")?.textContent).toContain("Uploading 1 of 1");
    });

    panelButton(
      panel,
      trigger === "cancel button" ? ".tp-upload-cancel" : ".tabstrip-tab__close",
    )?.click();
    await waitForFast(() => {
      expect(uploadSignal?.aborted).toBe(true);
      expect(panel.querySelector(".tp-upload-card")).toBeNull();
    });
    if (trigger === "cancel button") {
      expect(panelButton(panel, ".tp-upload")?.disabled).toBe(false);
      pendingUpload.resolve({ path: "/tmp/openclaw upload/archive.zip", size: 3 });
    } else {
      pendingUpload.reject(new Error("terminal closed"));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.terminal.paste).not.toHaveBeenCalled();
    expect(panel.querySelector(".tp-upload-card")).toBeNull();
  },
);
