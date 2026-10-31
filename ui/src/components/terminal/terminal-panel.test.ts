/* @vitest-environment jsdom */

import { createComponent, createSignal, flush, lazy, Loading } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { prepareCatalogTerminal } from "../../lib/sessions/catalog-terminal-start.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { preserveDocumentStyle } from "../../test-helpers/preserve-document-style.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { eventGateway, mountPanel as mount } from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  createTerminalGatewayClient,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
  type CreateOptions,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
import { terminalIntentQueue } from "./terminal-pending-actions.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();

const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

async function startPanelWithPendingOpen(sessionKey?: string, hosted = false) {
  let createOptions: CreateOptions | undefined;
  createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
    createOptions = options;
    return createTerminalController();
  });
  const open = createDeferred<ReturnType<typeof terminalOpenResult>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client: TerminalGatewayClient = createTerminalGatewayClient(
    <T>(method: string, params?: unknown) => {
      requests.push({ method, params });
      return (
        method === "terminal.open"
          ? open.promise
          : Promise.resolve(method === "terminal.list" ? { sessions: [] } : { ok: true })
      ) as Promise<T>;
    },
  );
  const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
  panel.client = client;
  panel.sessionKey = sessionKey ?? null;
  panel.available = true;
  panel.embedded = hosted;
  panel.tabsInHeader = hosted;
  document.body.append(panel);
  if (!hosted) {
    panel.toggle();
  }
  await waitForFast(() =>
    expect(requests.some(({ method }) => method === "terminal.open")).toBe(true),
  );
  return { createOptions: createOptions!, open, panel, requests };
}

describe("OpenClawTerminalPanel", () => {
  beforeAll(async () => {
    // Load the real responder before short RPC assertions begin on a cold worker.
    await import("@openclaw/libterminal/browser");
  });

  beforeEach(async () => {
    preserveDocumentStyle();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    for (const property of ["--bg", "--text", "--accent"]) {
      document.documentElement.style.removeProperty(property);
    }
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
    sessionStorage.clear();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    const tagName = `test-lazy-terminal-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    Object.assign(element, {
      available: true,
    });
    document.body.append(element);

    defineTestTerminalPanelElement(createGhosttyTerminalMock, tagName);
    const panel = element as unknown as OpenClawTerminalPanel;
    await panel.updateComplete;
    await waitForFast(() => expect(panel.terminalPanelOpen).toBe(true));
  });

  it("activates a Solid terminal when its detached container connects later", async () => {
    const { TerminalPanelHost } = await import("./terminal-panel-registration.tsx");
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    const request = vi.fn(async (method: string) =>
      method === "terminal.open"
        ? terminalOpenResult("late-connected-terminal")
        : method === "terminal.list"
          ? { sessions: [] }
          : { ok: true },
    );
    const client: TerminalGatewayClient = {
      forceReconnect() {},
      // SAFETY: This fixture supplies the response shape for each terminal method it serves.
      request: <T>(method: string) => request(method) as Promise<T>,
      addEventListener: () => () => {},
    };
    const container = document.createElement("div");
    const mounted = mountSolid(
      () => TerminalPanelHost({ client, available: true, embedded: true }),
      { container },
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
      await terminalIntentQueue.queue(
        { kind: "open", agentId: null },
        { deferUntilHostChange: true },
      );
      document.body.append(container);
      await waitForFast(() => expect(request).toHaveBeenCalledWith("terminal.open"));
      await waitForFast(() => expect(container.querySelector(".tp-composer input")).not.toBeNull());
      expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
      expect(createGhosttyTerminalMock.mock.calls[0]?.[0].parent.isConnected).toBe(true);
      document.body.append(container);
      await Promise.resolve();
      expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(1);
      await waitForFast(() => expect(terminalIntentQueue.hasActions).toBe(false));
    } finally {
      container.querySelector("openclaw-terminal-panel")?.closeTerminalPanel();
      mounted.unmount();
      container.remove();
    }
  });

  it("shows the embedded desktop session picker initially and preserves its dismissal", async () => {
    const Terminal = lazy(() => import("./terminal-panel-registration.tsx"), {
      export: "TerminalPanelHost",
    });
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const currentSession = terminalOpenResult("embedded-current-session");
    const client: TerminalGatewayClient = {
      forceReconnect() {},
      // SAFETY: The fixture returns the declared response for each terminal method.
      request: async <T>(method: string) =>
        (method === "terminal.open"
          ? currentSession
          : method === "terminal.list"
            ? { sessions: [{ ...currentSession, attached: true, createdAtMs: 1 }] }
            : { ok: true }) as T,
      addEventListener: () => () => {},
    };
    const container = document.body.appendChild(document.createElement("div"));
    const [themeMode, setThemeMode] = createSignal<"dark" | "light">("dark");
    const mounted = mountSolid(
      () =>
        createComponent(Loading, {
          get children() {
            return createComponent(Terminal, {
              client,
              available: true,
              embedded: true,
              mobile: false,
              get themeMode() {
                return themeMode();
              },
            });
          },
        }),
      { container },
    );
    try {
      await vi.dynamicImportSettled();
      await waitForFast(() =>
        expect(container.querySelector(".tp-session.is-current")).not.toBeNull(),
      );
      container.querySelector<HTMLButtonElement>(".tp-session.is-current")!.click();
      await waitForFast(() => expect(container.querySelector(".tp-session-menu")).toBeNull());
      expect(container.querySelector(".tp-composer input")).not.toBeNull();
      setThemeMode("light");
      flush();
      await container.querySelector("openclaw-terminal-panel")!.updateComplete;
      expect(container.querySelector(".tp-session-menu")).toBeNull();
      expect(container.querySelector(".tp-composer input")).not.toBeNull();
      await waitForFast(() => expect(terminalIntentQueue.hasActions).toBe(false));
    } finally {
      container.querySelector("openclaw-terminal-panel")?.closeTerminalPanel();
      mounted.unmount();
      container.remove();
    }
  });

  it.each([{ dock: "right", label: "Dock to right" }] as const)(
    "moves the persisted $dock dock into main content and back by destination",
    async ({ dock, label }) => {
      localStorage.setItem(
        "openclaw.terminal.panel.v1",
        JSON.stringify({ open: true, dock, height: 320, width: 520 }),
      );
      const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { available: true }, false);
      await panel.updateComplete;

      panel.querySelector<HTMLButtonElement>('[aria-label="Fill main content area"]')?.click();
      await panel.updateComplete;

      expect(panel.querySelector(".tp")?.classList.contains("tp--main")).toBe(true);
      expect(panel.querySelector(".tp-resizer")).toBeNull();
      expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}")).toMatchObject({
        open: true,
        dock: "main",
      });

      panel.remove();
      await Promise.resolve();
      const restored = mount(TERMINAL_PANEL_ELEMENT_NAME, { available: true }, false);
      await restored.updateComplete;
      // Destinations only: the occupied main placement drops out of the
      // cluster, and leaving it is an explicit destination pick.
      expect(restored.querySelector('[aria-label="Fill main content area"]')).toBeNull();
      restored.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
      await restored.updateComplete;

      expect(restored.querySelector(".tp")?.classList.contains(`tp--${dock}`)).toBe(true);
      restored.remove();
      await Promise.resolve();
    },
  );

  it("opens new sessions for the selected agent", async () => {
    let createOptions: CreateOptions | undefined;
    createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
      createOptions = options;
      return createTerminalController();
    });
    const { client, calls } = eventGateway((method) =>
      method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.list"
          ? { sessions: [] }
          : { ok: true },
    );
    const panel = mount(
      TERMINAL_PANEL_ELEMENT_NAME,
      { client, agentId: "ops", available: true },
      false,
    );

    panel.toggle();

    await waitForFast(() => {
      expect(calls("terminal.open")).toEqual([{ agentId: "ops", cols: 100, rows: 30 }]);
    });
    expect(createOptions?.terminalOptions?.fontSize).toBe(11);
    expect(createOptions?.terminalOptions?.fontFamily).toContain("OpenClaw Nerd Symbols");
    expect(getComputedStyle(createOptions!.parent).caretColor).toBe("rgba(0, 0, 0, 0)");
    await waitForFast(() => {
      expect(calls("terminal.resize")).toContainEqual({
        sessionId: "session-1",
        cols: 100,
        rows: 30,
      });
    });

    createOptions?.onData?.(new TextEncoder().encode("pwd\n"));
    createOptions?.onResize?.({ columns: 120, rows: 40 });
    await waitForFast(() => {
      expect(calls("terminal.input")).toContainEqual({ sessionId: "session-1", data: "pwd\n" });
      expect(calls("terminal.resize")).toContainEqual({
        sessionId: "session-1",
        cols: 120,
        rows: 40,
      });
    });
  });

  it("keeps the attached terminal canvas while typing and submitting composer input", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const { client } = eventGateway((method) =>
      method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.list"
          ? { sessions: [] }
          : { ok: true },
    );
    const panel = mount(
      TERMINAL_PANEL_ELEMENT_NAME,
      { client, available: true, embedded: true, mobile: true },
      false,
    );
    await waitForFast(() => expect(controller.terminal.focus).toHaveBeenCalled());
    await panel.updateComplete;
    const host = createGhosttyTerminalMock.mock.calls[0]![0].parent;
    const input = panel.querySelector<HTMLInputElement>(".tp-composer input")!;
    expect(host.parentElement).toBe(panel.findTerminalPanelViewport());
    controller.fit.mockClear();
    controller.terminal.renderer.render.mockClear();

    input.value = "echo census";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    expect(controller.fit).toHaveBeenCalled();
    expect(controller.terminal.renderer.render).not.toHaveBeenCalled();

    panel
      .querySelector<HTMLFormElement>(".tp-composer")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await panel.updateComplete;
    expect(controller.terminal.paste).toHaveBeenCalledWith("echo census");
    expect(controller.terminal.input).toHaveBeenCalledWith("\r", true);
    expect(input.value).toBe("");
    expect(host.parentElement).toBe(panel.findTerminalPanelViewport());
    expect(controller.terminal.renderer.render).not.toHaveBeenCalled();
  });

  it.each(["active", "inactive", "both"] as const)(
    "repaints only a surviving revealed terminal after closing %s tabs",
    async (closed) => {
      const active = closed !== "inactive";
      const controllers = [createTerminalController(), createTerminalController()] as const;
      createGhosttyTerminalMock
        .mockResolvedValueOnce(controllers[0])
        .mockResolvedValueOnce(controllers[1]);
      let session = 0;
      const { client } = eventGateway((method) =>
        method === "terminal.open"
          ? terminalOpenResult(`session-${++session}`)
          : method === "terminal.list"
            ? { sessions: [] }
            : { ok: true },
      );
      const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true });
      await waitForFast(() => expect(controllers[0].terminal.focus).toHaveBeenCalled());
      panel.querySelector<HTMLButtonElement>(".tabstrip-new")!.click();
      await waitForFast(() => expect(controllers[1].terminal.focus).toHaveBeenCalled());
      await panel.updateComplete;
      const replacement = controllers[active ? 0 : 1];
      const host = createGhosttyTerminalMock.mock.calls[active ? 0 : 1]![0].parent;
      expect(host.parentElement).toBe(panel.findTerminalPanelViewport());
      expect(host.style.display).toBe(active ? "none" : "block");
      for (const controller of controllers) {
        controller.terminal.renderer.render.mockClear();
        controller.terminal.focus.mockClear();
      }

      panel.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[active ? 1 : 0]!.click();
      if (closed === "both") {
        panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
      }
      await panel.updateComplete;

      expect(host.isConnected).toBe(closed !== "both");
      if (closed !== "both") {
        expect(host.parentElement).toBe(panel.findTerminalPanelViewport());
        expect(host.style.display).toBe("block");
      }
      expect(replacement.terminal.focus).not.toHaveBeenCalled();
      if (closed === "active") {
        expect(replacement.terminal.renderer.render).toHaveBeenCalledWith(
          replacement.terminal.wasmTerm,
          true,
          0,
          replacement.terminal,
          0,
        );
      } else {
        expect(replacement.terminal.renderer.render).not.toHaveBeenCalled();
      }
    },
  );

  it("forces a full render after hiding and showing the panel", async () => {
    const controller = createTerminalController();
    let createOptions: CreateOptions | undefined;
    createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
      createOptions = options;
      return controller;
    });
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : { ok: true }) as T,
    );
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();

    await waitForFast(() => expect(createOptions?.parent.isConnected).toBe(true));
    controller.fit.mockClear();
    controller.terminal.renderer.render.mockClear();

    panel.toggle();
    await panel.updateComplete;
    expect(createOptions?.parent.isConnected).toBe(false);

    panel.toggle();
    await panel.updateComplete;

    expect(createOptions?.parent.isConnected).toBe(true);
    expect(controller.fit).toHaveBeenCalled();
    expect(controller.terminal.renderer.render).toHaveBeenCalledWith(
      controller.terminal.wasmTerm,
      true,
      0,
      controller.terminal,
      0,
    );
  });

  it("keeps terminal rendering and OSC default-color replies in sync with theme tokens", async () => {
    const root = document.documentElement;
    root.style.setProperty("--bg", "#0e1015");
    root.style.setProperty("--text", "#d7dae0");
    root.style.setProperty("--accent", "#ff5c5c");
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (
          method === "terminal.open"
            ? terminalOpenResult("session-1")
            : method === "terminal.list"
              ? { sessions: [] }
              : { ok: true }
        ) as T;
      },
      (nextListener) => {
        listener = nextListener;
        return () => {};
      },
    );
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();
    await waitForFast(() => {
      expect(requests.some(({ method }) => method === "terminal.resize")).toBe(true);
    });

    const query = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b]12;?\u001b\\";
    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: query.length, data: query },
    });

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]10;rgb:d7d7/dada/e0e0\u001b\\",
        },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]11;rgb:0e0e/1010/1515\u001b\\",
        },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]12;rgb:ffff/5c5c/5c5c\u001b\\",
        },
      });
    });
    expect(new TextDecoder().decode(controller.write.mock.calls[0]?.[0])).toBe(query);

    controller.terminal.renderer.setTheme.mockClear();
    controller.terminal.renderer.render.mockClear();
    root.dataset.theme = "knot";
    root.style.setProperty("--bg", "#080808");
    root.style.setProperty("--text", "#e0e0e2");
    root.style.setProperty("--accent", "#14b8a6");

    await waitForFast(() => {
      expect(controller.terminal.renderer.setTheme).toHaveBeenCalledWith(
        expect.objectContaining({
          background: "#080808",
          foreground: "#e0e0e2",
          cursor: "#14b8a6",
          cursorAccent: "#080808",
          selectionBackground: "#14b8a652",
        }),
      );
      expect(controller.terminal.renderer.render).toHaveBeenCalled();
    });

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: query.length * 2, data: query },
    });
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]10;rgb:e0e0/e0e0/e2e2\u001b\\" },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]11;rgb:0808/0808/0808\u001b\\" },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]12;rgb:1414/b8b8/a6a6\u001b\\" },
      });
    });
  });

  it("flushes keystrokes entered while open is in flight after resize resync", async () => {
    const { createOptions, open, requests } = await startPanelWithPendingOpen();
    createOptions.onData?.(new TextEncoder().encode("first"));
    createOptions.onData?.(new TextEncoder().encode("second"));

    open.resolve(terminalOpenResult("session-1"));

    await waitForFast(() =>
      expect(requests.filter(({ method }) => method === "terminal.input")).toHaveLength(2),
    );
    expect(
      requests.filter(({ method }) => method === "terminal.resize" || method === "terminal.input"),
    ).toEqual([
      {
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 100, rows: 30 },
      },
      { method: "terminal.input", params: { sessionId: "session-1", data: "first" } },
      { method: "terminal.input", params: { sessionId: "session-1", data: "second" } },
    ]);
  });

  it("discards buffered startup input when open fails", async () => {
    const { createOptions, open, panel, requests } = await startPanelWithPendingOpen(
      undefined,
      true,
    );
    createOptions.onData?.(new TextEncoder().encode("never send"));

    open.reject(new Error("terminal open refused"));

    await waitForFast(() => {
      expect(panel.querySelector(".tp-error")?.textContent).toContain("terminal open refused");
    });
    expect(requests.some(({ method }) => method === "terminal.input")).toBe(false);
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-panel-empty-state")).toBeNull();
  });

  it("closes a session-scoped terminal cancelled after its open response", async () => {
    const { open, panel, requests } = await startPanelWithPendingOpen("agent:main:chat");
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")?.click();

    open.resolve(terminalOpenResult("session-1"));

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: "session-1" },
      });
    });
  });

  it("closes a prepared native terminal when its page renderer fails to initialize", async () => {
    createGhosttyTerminalMock.mockRejectedValue(new Error("renderer initialization failed"));
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (
          method === "sessions.catalog.startTerminal"
            ? terminalOpenResult("prepared-session")
            : { ok: true }
        ) as T;
      },
    );
    await prepareCatalogTerminal(
      client,
      { catalogId: "codex", agentId: "ops", hostId: "gateway:local", cwd: "/work/ops" },
      () => true,
    );
    const panel = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    panel.client = client;
    panel.available = true;
    panel.page = panel.fullscreen = panel.embedded = true;
    panel.routeTarget = { sessionId: "prepared-session" };
    document.body.append(panel);

    await waitForFast(() => {
      expect(panel.querySelector(".tp-error")?.textContent).toContain(
        "renderer initialization failed",
      );
    });
    expect(requests).toContainEqual({
      method: "terminal.close",
      params: { sessionId: "prepared-session" },
    });
  });

  it.each(["missing", "transient"] as const)(
    "reconciles a persisted session after a %s attach failure",
    async (failure) => {
      const sessionId = failure === "missing" ? "gone-1" : "live-1";
      sessionStorage.setItem("openclaw.terminal.sessions.v1", JSON.stringify([sessionId]));
      const controller = createTerminalController();
      if (failure === "missing") {
        createGhosttyTerminalMock.mockResolvedValue(controller);
      } else {
        createGhosttyTerminalMock.mockResolvedValueOnce(controller);
      }
      const requests: Array<{ method: string; params: unknown }> = [];
      let listCalls = 0;
      const client: TerminalGatewayClient = createTerminalGatewayClient(
        async <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          if (method === "terminal.list") {
            listCalls += 1;
            return {
              sessions:
                failure === "transient" || listCalls === 1
                  ? [{ ...terminalOpenResult(sessionId), attached: false, createdAtMs: 1 }]
                  : [],
            } as T;
          }
          if (method === "terminal.attach") {
            throw new Error(
              failure === "missing"
                ? `unknown terminal session "${sessionId}"`
                : "gateway temporarily unavailable",
            );
          }
          if (method === "terminal.open") {
            return terminalOpenResult("replacement-1") as T;
          }
          return { ok: true } as T;
        },
      );
      const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);

      panel.toggle();

      if (failure === "missing") {
        await waitForFast(() => {
          expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
        });
      } else {
        await waitForFast(() => {
          expect(panel.querySelector('.tp-error[role="alert"]')?.textContent).toContain(
            "Could not attach terminal session",
          );
        });
        expect(panel.querySelector(".tabstrip-tab__status")?.textContent).not.toBe("exited");
      }
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(0);
      // Restoration and attach reconciliation are independent of dock catalog discovery.
      expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(3);
      expect(requests.filter((entry) => entry.method === "terminal.attach")).toHaveLength(1);
      expect(controller.write).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(failure === "missing" ? [] : [sessionId]),
      );
    },
  );

  it("shows a session picker list failure without retiring the active terminal", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    let listCalls = 0;
    let failNextList = false;
    const client: TerminalGatewayClient = createTerminalGatewayClient(async <T>(method: string) => {
      if (method === "terminal.open") {
        return terminalOpenResult("current-1") as T;
      }
      if (method === "terminal.list") {
        listCalls += 1;
        if (failNextList) {
          failNextList = false;
          throw new Error("synthetic terminal list unavailable");
        }
        return {
          sessions: [{ ...terminalOpenResult("detached-1"), attached: false, createdAtMs: 1 }],
        } as T;
      }
      return Promise.resolve({ ok: true }) as Promise<T>;
    });
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();
    await waitForFast(() =>
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(["current-1"]),
      ),
    );

    await waitForFast(() => expect(listCalls).toBe(1));
    failNextList = true;
    panel.querySelector<HTMLButtonElement>('[aria-label="Terminal sessions"]')!.click();
    await waitForFast(() =>
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
        "synthetic terminal list unavailable",
      ),
    );
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["current-1"]),
    );
    expect(panel.querySelector(".tp-session-menu")).toBeNull();
    const trigger = panel.querySelector<HTMLButtonElement>('[aria-label="Terminal sessions"]')!;
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    await waitForFast(() =>
      expect(panel.querySelector(".tp-session__cwd")?.textContent).toContain("ops"),
    );
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    // Returning focus after the failure also discovers the dock catalog.
    expect(listCalls).toBe(4);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps the newest session picker refresh when older requests %s out of order",
    async (outcome) => {
      createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
      type ListedSession = ReturnType<typeof terminalOpenResult> & {
        attached: boolean;
        createdAtMs: number;
      };
      const firstList = createDeferred<{ sessions: ListedSession[] }>();
      const secondList = createDeferred<{ sessions: ListedSession[] }>();
      let listCount = 0;
      const client: TerminalGatewayClient = createTerminalGatewayClient(<T>(method: string) => {
        if (method === "terminal.open") {
          return Promise.resolve(terminalOpenResult("current-1")) as Promise<T>;
        }
        if (method === "terminal.list") {
          listCount += 1;
          return (
            listCount === 1
              ? Promise.resolve({ sessions: [] })
              : listCount === 2
                ? firstList.promise
                : secondList.promise
          ) as Promise<T>;
        }
        return Promise.resolve({}) as Promise<T>;
      });
      const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
      panel.toggle();
      await waitForFast(() => expect(panel.querySelector(".tp-actions")).not.toBeNull());

      await waitForFast(() => expect(listCount).toBe(1));
      (panel.querySelector('[aria-label="Terminal sessions"]') as HTMLButtonElement).click();
      await waitForFast(() => expect(listCount).toBe(2));
      const refresh = panel.querySelector<HTMLButtonElement>(".tp-session-refresh")!;
      const loading = () =>
        panel.querySelector('.tp-session-menu [data-panel-skeleton="terminal"]');
      await waitForFast(() => {
        expect(loading()?.getAttribute("aria-label")).toBe("Loading sessions…");
        expect(document.activeElement).toBe(refresh);
      });
      refresh.click();
      await waitForFast(() => expect(listCount).toBe(3));
      expect(loading()).not.toBeNull();
      expect(document.activeElement).toBe(refresh);

      secondList.resolve({
        sessions: [
          {
            ...terminalOpenResult("new"),
            agentId: "new-agent",
            attached: false,
            createdAtMs: 2,
          },
        ],
      });
      await waitForFast(() => {
        expect(panel.querySelector(".tp-session-menu")?.textContent).toContain("new-agent");
        expect(loading()).toBeNull();
      });
      expect(document.activeElement).toBe(refresh);
      if (outcome === "reject") {
        firstList.reject(new Error("superseded list failure"));
      } else {
        firstList.resolve({
          sessions: [
            {
              ...terminalOpenResult("old"),
              agentId: "old-agent",
              attached: false,
              createdAtMs: 1,
            },
          ],
        });
      }
      await Promise.resolve();
      await panel.updateComplete;

      const menu = panel.querySelector(".tp-session-menu")?.textContent;
      expect(menu).toContain("new-agent");
      expect(menu).not.toContain("old-agent");
      expect(loading()).toBeNull();
      expect(document.activeElement).toBe(refresh);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("shows a picker attach failure after the listed session disappears", async () => {
    createGhosttyTerminalMock
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController());
    const client: TerminalGatewayClient = createTerminalGatewayClient(async <T>(method: string) => {
      if (method === "terminal.open") {
        return terminalOpenResult("current-1") as T;
      }
      if (method === "terminal.attach") {
        throw new Error("session expired");
      }
      if (method === "terminal.list") {
        return {
          sessions: [{ ...terminalOpenResult("expired-1"), attached: false, createdAtMs: 1 }],
        } as T;
      }
      return { ok: true } as T;
    });
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();
    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(["current-1"]),
      );
    });

    panel.querySelector<HTMLButtonElement>('[aria-label="Terminal sessions"]')!.click();
    await waitForFast(() => expect(panel.querySelector(".tp-session")).not.toBeNull());
    panel.querySelector<HTMLButtonElement>(".tp-session")!.click();
    await waitForFast(() =>
      expect(panel.textContent).toContain("Could not attach terminal session"),
    );
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["current-1"]),
    );
  });

  it("opens a catalog page independently while the dock is still booting", async () => {
    const firstBoot = createDeferred<ReturnType<typeof createTerminalController>>();
    createGhosttyTerminalMock
      .mockReturnValueOnce(firstBoot.promise)
      .mockResolvedValueOnce(createTerminalController());
    const { client, calls } = eventGateway((method) =>
      method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.list"
          ? { sessions: [] }
          : { ok: true },
    );
    const dock = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    dock.toggle();
    await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledOnce());
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };
    const page = createTestTerminalPanel(TERMINAL_PANEL_ELEMENT_NAME);
    page.client = client;
    page.available = true;
    page.agentId = "research";
    page.page = page.fullscreen = page.embedded = true;
    page.routeTarget = { catalog };
    document.body.append(page);
    await waitForFast(() =>
      expect(calls("terminal.open")).toContainEqual({
        agentId: "research",
        cols: 100,
        rows: 30,
        catalog,
      }),
    );
    await page.updateComplete;
    expect(page.querySelector(".tp-session-menu")).toBeNull();
    expect(page.querySelector(".tp-viewport")?.getAttribute("aria-hidden")).toBe("false");
    firstBoot.resolve(createTerminalController());
    await waitForFast(() => expect(calls("terminal.open")).toHaveLength(2));
  });

  it("fullscreen mode auto-opens without dock chrome and survives last-tab close", async () => {
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    const { client, calls } = eventGateway((method) =>
      method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.list"
          ? { sessions: [] }
          : { ok: true },
    );
    const panel = mount(
      TERMINAL_PANEL_ELEMENT_NAME,
      { client, available: true, fullscreen: true },
      false,
    );

    // No toggle: the terminal-only document opens its session on mount.
    await waitForFast(() => {
      expect(calls("terminal.open")).not.toHaveLength(0);
    });
    await panel.updateComplete;
    const section = panel.querySelector(".tp");
    expect(section?.classList.contains("tp--fullscreen")).toBe(true);
    expect(panel.querySelector(".tp-resizer")).toBeNull();
    expect(panel.querySelector(".tp-upload")).not.toBeNull();
    expect(panel.querySelectorAll(".tp-actions button")).toHaveLength(1);

    // Closing the last tab must keep the panel (with its "+" button) rendered —
    // a fullscreen document has no toggle to bring a closed panel back.
    (panel.querySelector(".tabstrip-tab__close") as HTMLElement).click();
    await panel.updateComplete;
    expect(calls("terminal.close")).not.toHaveLength(0);
    expect(panel.querySelector(".tp")).not.toBeNull();
    expect(panel.querySelector(".tabstrip-new")).not.toBeNull();
  });

  it("marks the old session exited when a replacement client no longer lists it", async () => {
    const controllers = [createTerminalController(), createTerminalController()] as const;
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1]);

    const oldRequests: string[] = [];
    const oldUnsubscribe = vi.fn();
    const oldClient: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string) => {
        oldRequests.push(method);
        return (
          method === "terminal.open"
            ? terminalOpenResult("old-session")
            : method === "terminal.list"
              ? { sessions: [] }
              : { ok: true }
        ) as T;
      },
      () => oldUnsubscribe,
    );
    const newRequests: string[] = [];
    const newClient: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string) => {
        newRequests.push(method);
        if (method === "terminal.list") {
          return { sessions: [] } as T;
        }
        return (method === "terminal.open" ? terminalOpenResult("new-session") : { ok: true }) as T;
      },
    );
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client: oldClient, available: true }, false);
    panel.toggle();

    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain("old-session");
    });
    panel.client = newClient;
    await panel.updateComplete;
    // Reconnect restoration waits for the lazy service-worker refresh module.
    await vi.dynamicImportSettled();

    await waitForFast(() => {
      expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(oldRequests.filter((method) => method === "terminal.open")).toHaveLength(1);
    expect(newRequests).toEqual(["terminal.list", "terminal.list"]);
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[1].write).not.toHaveBeenCalled();
  });

  it("discards an async boot that finishes after disconnect and reconnect", async () => {
    const staleController = createTerminalController();
    const currentController = createTerminalController();
    const staleBoot = createDeferred<typeof staleController>();
    createGhosttyTerminalMock
      .mockImplementationOnce(async () => staleBoot.promise)
      .mockResolvedValueOnce(currentController);
    const requests: string[] = [];
    const client: TerminalGatewayClient = createTerminalGatewayClient(async <T>(method: string) => {
      requests.push(method);
      return (
        method === "terminal.open" ? terminalOpenResult("current-session") : { ok: true }
      ) as T;
    });
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();

    await waitForFast(() => {
      expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
    });
    const staleOptions = createGhosttyTerminalMock.mock.calls[0]![0] as CreateOptions;
    const staleHost = staleOptions.parent;
    panel.remove();
    await Promise.resolve();
    document.body.append(panel);

    await panel.updateComplete;
    expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
    expect(requests.filter((method) => method === "terminal.open")).toHaveLength(0);
    staleBoot.resolve(staleController);

    await waitForFast(() => {
      expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
      expect(requests.filter((method) => method === "terminal.open")).toHaveLength(1);
    });

    await waitForFast(() => {
      expect(staleController.dispose).toHaveBeenCalledOnce();
    });
    expect(staleHost.isConnected).toBe(false);
    expect(requests.filter((method) => method === "terminal.open")).toHaveLength(1);
    expect(currentController.dispose).not.toHaveBeenCalled();
  });

  it("removes resize listeners when disconnected mid-drag", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : { ok: true }) as T,
    );
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();
    await panel.updateComplete;

    panel
      .querySelector(".tp-resizer")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 200 }));
    panel.remove();
    await Promise.resolve();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 20 }));

    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right")).toBe(
      "0px",
    );
  });

  it("retranslates cached exit state when the locale changes", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = createTerminalGatewayClient(
      async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : { ok: true }) as T,
      (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
    );
    const panel = mount(TERMINAL_PANEL_ELEMENT_NAME, { client, available: true }, false);
    panel.toggle();
    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain("session-1");
    });

    listener?.({
      event: "terminal.exit",
      payload: { sessionId: "session-1", exitCode: null, reason: "detached" },
    });
    await panel.updateComplete;
    expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("detached");

    await i18n.setLocale("de");
    await panel.updateComplete;
    expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("getrennt");
  });
});
