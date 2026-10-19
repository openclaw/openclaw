/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { takeSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { createLazyElementSpec, resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
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

function configurePanelShell(
  label: string,
  kind: "terminal" | "browser" = "terminal",
  options?: Parameters<typeof createLazyElementSpec>[1],
) {
  const element = createLazyElementSpec(label, options);
  window.history.replaceState(null, "", "/usage");
  const shell = createShellOwner() as unknown as ShellPanelToggleState;
  Object.defineProperty(shell, `${kind}PanelElement`, { value: element });
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
  const panel = shell.element.appendChild(document.createElement(element.tagName));
  if (kind === "browser") {
    shell.elements.browserPanel = panel;
  } else {
    shell.terminalPanel = panel;
  }
  document.body.append(shell.element);
  onTestFinished(() => shell.element.remove());
  return { shell, element, owner: new ShellChromeOwner(shell) };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  resetAppHostTestGlobals();
});

describe("OpenClaw shell panel toggles", () => {
  it("captures the terminal chord once before a consuming target", async () => {
    const { element, owner } = configurePanelShell("keyboard terminal");
    await element.loadModule();
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
    const { shell, owner } = configurePanelShell("assistant panel");
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
    const terminalElement = createLazyElementSpec("session terminal panel");
    const shell = createShellOwner() as unknown as ShellPanelToggleState;
    Object.defineProperty(shell, "terminalPanelElement", { value: terminalElement });
    shell.routeState = { routeId: "chat" };

    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail: { open: true } });
    new ShellChromeOwner(shell).panels.handleDeferredTerminalToggle(event);

    expect(customElements.get(terminalElement.tagName)).toBeUndefined();
    expect(takeSessionPanelToggle("terminal")).toBe(event);
  });

  it("does not repeat a dismissed restoration until the context lifecycle resets", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw.terminal.panel.v1", JSON.stringify({ open: true }));
    const { element, shell, owner } = configurePanelShell("restored terminal", "terminal", {
      firstError: new Error("offline"),
    });
    const load = vi.spyOn(element, "loadModule");
    owner.panels.restore();
    await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
    shell.lazyCustomElements.close();
    owner.panels.restore();
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    expect(shell.lazyCustomElements.visibleState).toBeUndefined();
    owner.abandonPendingLazyActionForContext();
    owner.panels.restore();
    await vi.waitFor(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retains the exact rejected terminal panel request through in-place retry", async () => {
    const eventType = TERMINAL_PANEL_TOGGLE_EVENT;
    const detail = { dock: "right", open: true, terminalSessionId: "terminal-1" };
    const error = new Error("panel chunk unavailable");
    const { shell, owner } = configurePanelShell("terminal panel", "terminal", {
      firstError: error,
    });
    const toggle = vi.fn();
    const event = new CustomEvent(eventType, { detail });
    listen(eventType, toggle);
    owner.panels.handleDeferredTerminalToggle(event);
    await vi.waitFor(() =>
      expect(shell.lazyCustomElements.visibleState).toMatchObject({ status: "error", error }),
    );
    expect(toggle).not.toHaveBeenCalled();
    shell.lazyCustomElements.retry();
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledOnce());
    const delivered = toggle.mock.calls[0]?.[0] as CustomEvent;
    expect(delivered).not.toBe(event);
    expect(delivered.type).toBe(eventType);
    expect(delivered.detail).toEqual(detail);
  });

  it("restores a structured browser panel event once in a replacement shell", async () => {
    const eventType = BROWSER_PANEL_TOGGLE_EVENT;
    const detail = { dock: "right", open: true, url: "https://example.com/native", native: true };
    vi.stubGlobal("sessionStorage", createStorageMock());
    const toggle = vi.fn();
    persistLazyShellAction({ eventType, detail });
    const { element, owner } = configurePanelShell("restored browser", "browser");
    const restoreListener = owner.panels.handleDeferredBrowserToggle;
    const panelListener = (restored: Event) => {
      if (customElements.get(element.tagName)) {
        toggle(restored);
      }
    };
    listen(eventType, restoreListener);
    listen(eventType, panelListener);
    await vi.waitFor(() => {
      owner.restorePendingLazyAction();
      expect(toggle).toHaveBeenCalledOnce();
    });
    const restored = toggle.mock.calls[0]?.[0];
    expect(restored).toBeInstanceOf(CustomEvent);
    expect(restored?.type).toBe(eventType);
    expect((restored as CustomEvent).detail).toEqual(detail);
    expect(readLazyShellAction()).toBeNull();
  });
});
