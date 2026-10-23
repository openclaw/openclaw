/* @vitest-environment jsdom */

import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
} from "../components/panel-toggle-contract.ts";
import { takeSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
import { SHELL_COMPONENT_TAGS } from "./app-shell-components.ts";
import type { ApplicationContext } from "./context.ts";
import { persistLazyShellAction, readLazyShellAction } from "./lazy-shell-action.ts";

type ShellPanelToggleState = ShellChromeHost & {
  terminalPanel?: HTMLElement;
  runtime: { context: ApplicationContext };
};

function listen(type: string, listener: EventListener) {
  window.addEventListener(type, listener);
  onTestFinished(() => window.removeEventListener(type, listener));
}

function keyEvent(key: string, code: string, modifiers: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { key, code, cancelable: true, ...modifiers });
}

function createChromeOwner(host: ShellChromeHost) {
  return createRoot((dispose) => {
    const owner = new ShellChromeOwner(host);
    onTestFinished(() => {
      owner.disconnect();
      dispose();
    });
    return owner;
  });
}

function configurePanelShell(kind: "terminal" | "browser" = "terminal", mounted = true) {
  const tag = SHELL_COMPONENT_TAGS[kind];
  window.history.replaceState(null, "", "/usage");
  const shell = createShellOwner() as unknown as ShellPanelToggleState;
  if (kind === "browser") {
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
  }
  shell.routeState = { routeId: "usage" };
  shell.runtime = {
    context: {
      gateway: {
        connection: { gatewayUrl: "ws://127.0.0.1:1" },
        snapshot: {
          phase: "connected",
          client: {},
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["terminal.open"] },
          },
        },
      },
      config: { current: { terminalEnabled: true } },
    } as unknown as ApplicationContext,
  };
  Object.defineProperty(shell, "updateComplete", {
    configurable: true,
    get: () => Promise.resolve(true),
  });
  const panel = document.createElement(tag);
  if (mounted) {
    shell.element.append(panel);
  }
  if (kind === "browser") {
    shell.elements.browserPanel = panel;
  } else {
    shell.terminalPanel = panel;
  }
  document.body.append(shell.element);
  onTestFinished(() => shell.element.remove());
  return { shell, panel, owner: createChromeOwner(shell) };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  resetAppHostTestGlobals();
});

describe("OpenClaw shell panel toggles", () => {
  it("captures the terminal chord once before a consuming target", async () => {
    const { owner } = configurePanelShell();
    const target = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => target.remove());
    target.addEventListener("keydown", (event) => event.stopPropagation());
    const toggle = vi.fn();
    document.addEventListener("keydown", owner.handleDocumentKeydown, true);
    onTestFinished(() =>
      document.removeEventListener("keydown", owner.handleDocumentKeydown, true),
    );
    listen(TERMINAL_PANEL_TOGGLE_EVENT, toggle);
    const event = keyEvent("`", "Backquote", { ctrlKey: true, bubbles: true });
    target.dispatchEvent(event);
    expect(toggle).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the Home dock from its keyboard chord only when the gateway allows it", () => {
    const { shell, owner } = configurePanelShell();
    const gateway = shell.runtime.context.gateway;
    const homeToggle = vi.fn();
    listen(HOME_PANEL_TOGGLE_EVENT, homeToggle);
    const chord = () => keyEvent("h", "KeyH", { metaKey: true, shiftKey: true });
    const denied = chord();
    owner.handleDocumentKeydown(denied);
    expect(homeToggle).not.toHaveBeenCalled();
    expect(denied.defaultPrevented).toBe(false);

    gateway.snapshot.hello!.features!.methods = ["chat.history", "chat.send"];
    gateway.snapshot.hello!.auth = {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    };
    const allowed = chord();
    owner.handleDocumentKeydown(allowed);
    expect(homeToggle).toHaveBeenCalledOnce();
    expect(allowed.defaultPrevented).toBe(true);
  });

  it("buffers panel toggle events until the active chat pane mounts", () => {
    const shell = createShellOwner() as unknown as ShellPanelToggleState;
    shell.routeState = { routeId: "chat" };

    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail: { open: true } });
    createChromeOwner(shell).panels.handleDeferredTerminalToggle(event);

    expect(shell.queryRenderedElement(SHELL_COMPONENT_TAGS.terminal)).toBeNull();
    expect(takeSessionPanelToggle("terminal")).toBe(event);
  });

  it("does not repeat a restoration request until the context lifecycle resets", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw.terminal.panel.v1", JSON.stringify({ open: true }));
    const { owner } = configurePanelShell("terminal", false);
    const request = vi.spyOn(owner, "requestShellComponent");
    owner.panels.restore();
    expect(request).toHaveBeenCalledWith("terminal", undefined);
    owner.cancelShellComponentRequest("terminal");
    owner.panels.restore();
    expect(request).toHaveBeenCalledOnce();
    owner.abandonPendingLazyActionForContext();
    owner.panels.restore();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([TERMINAL_PANEL_TOGGLE_EVENT, TERMINAL_PANEL_DOCK_BOTTOM_EVENT])(
    "retains %s until its shell receiver mounts",
    (eventType) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const detail = { dock: "right", open: true, terminalSessionId: "terminal-1" };
      const { shell, panel, owner } = configurePanelShell("terminal", false);
      expect(owner.terminalActivationReady).toBe(false);
      owner.connect();
      expect(owner.terminalActivationReady).toBe(true);
      const toggle = vi.fn();
      const event = new CustomEvent(eventType, { detail });
      listen(eventType, toggle);
      if (eventType === TERMINAL_PANEL_DOCK_BOTTOM_EVENT) {
        shell.routeState = { routeId: "chat" };
        owner.panels.handleDeferredTerminalDock(event);
      } else {
        owner.panels.handleDeferredTerminalToggle(event);
      }
      expect(owner.isShellComponentRequested("terminal")).toBe(true);
      owner.restorePendingLazyAction();
      expect(toggle).not.toHaveBeenCalled();
      expect(readLazyShellAction()).toEqual({ eventType, detail });

      shell.element.append(panel);
      owner.restorePendingLazyAction();
      const delivered = toggle.mock.calls[0]?.[0] as CustomEvent;
      expect(delivered).not.toBe(event);
      expect([delivered.type, delivered.detail]).toEqual([eventType, detail]);
      expect(readLazyShellAction()).toBeNull();
      owner.restorePendingLazyAction();
      expect(toggle).toHaveBeenCalledOnce();
    },
  );

  it("restores a structured browser panel event once in a replacement shell", async () => {
    const eventType = BROWSER_PANEL_TOGGLE_EVENT;
    const detail = { dock: "right", open: true, url: "https://example.com/native", native: true };
    vi.stubGlobal("sessionStorage", createStorageMock());
    const toggle = vi.fn();
    persistLazyShellAction({ eventType, detail });
    const { shell, panel, owner } = configurePanelShell("browser", false);
    const restoreListener = owner.panels.handleDeferredBrowserToggle;
    const panelListener = (restored: Event) => {
      if (panel.isConnected) {
        toggle(restored);
      }
    };
    listen(eventType, restoreListener);
    listen(eventType, panelListener);
    owner.restorePendingLazyAction();
    expect(toggle).not.toHaveBeenCalled();
    shell.element.append(panel);
    owner.restorePendingLazyAction();
    expect(toggle).toHaveBeenCalledOnce();
    const restored = toggle.mock.calls[0]?.[0];
    expect(restored).toBeInstanceOf(CustomEvent);
    expect([restored?.type, (restored as CustomEvent).detail]).toEqual([eventType, detail]);
    expect(readLazyShellAction()).toBeNull();
  });
});
