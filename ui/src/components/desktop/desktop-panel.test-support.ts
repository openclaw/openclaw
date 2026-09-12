import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";
import "./desktop-panel.ts";

type DesktopPanelElement = HTMLElementTagNameMap["openclaw-desktop-panel"];

export const desktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: ["main"],
    tunnelStatus: "connected",
    desktopApps: [],
  },
} as const;

export function createPanel() {
  return document.createElement("openclaw-desktop-panel");
}

export function createConnectionHandle(overrides: Partial<DesktopConnectionHandle> = {}) {
  return {
    disconnect: vi.fn(),
    disableInput: vi.fn(),
    sendBackspace: vi.fn(),
    sendKeyboardEvent: vi.fn(),
    sendText: vi.fn(),
    setSizingMode: vi.fn(),
    ...overrides,
  } satisfies DesktopConnectionHandle;
}

export function clickPanelButton(
  panel: DesktopPanelElement,
  selector = ".desktop-environment button",
): void {
  const button = panel.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`expected Desktop button: ${selector}`);
  }
  button.click();
}

export function sizingMenu(panel: DesktopPanelElement): HTMLSelectElement {
  const menu = panel.renderRoot.querySelector<HTMLSelectElement>(".desktop-sizing");
  if (!menu) {
    throw new Error("expected the desktop sizing menu");
  }
  return menu;
}

export function selectSizing(panel: DesktopPanelElement, mode: string): void {
  const menu = sizingMenu(panel);
  menu.value = mode;
  menu.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function settleTasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

export function createGatewayClient(request: unknown) {
  const listeners = new Set<GatewayEventListener>();
  const unsubscribe = vi.fn((listener: GatewayEventListener) => listeners.delete(listener));
  return {
    client: {
      gatewayUrl: "ws://gateway.test",
      request,
      addEventListener(listener: GatewayEventListener) {
        listeners.add(listener);
        return () => unsubscribe(listener);
      },
    } as unknown as GatewayBrowserClient,
    emit(event: string, payload: unknown) {
      for (const listener of Array.from(listeners)) {
        if (listeners.has(listener)) {
          listener({ type: "event", event, payload });
        }
      }
    },
    unsubscribe,
  };
}
