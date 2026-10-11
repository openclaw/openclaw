import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";
import { DesktopPanelController } from "./desktop-panel-controller.ts";
import { DesktopPanelContent } from "./desktop-panel-solid.tsx";

type DesktopPanelElement = DesktopPanelController;
const mountedPanels = new WeakMap<DesktopPanelController, ReturnType<typeof mountSolid>>();

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
  const panel = new DesktopPanelController(document.createElement("div"));
  updatePanel(panel, {
    sessions: {
      describe: (params, options) => {
        const client = options?.client ?? panel.client;
        if (!client) {
          throw new Error("Desktop fixture has no Gateway client");
        }
        return client.request("sessions.describe", params);
      },
    },
  });
  return panel;
}

export function createConnectionHandle(overrides: Partial<DesktopConnectionHandle> = {}) {
  return {
    disconnect: vi.fn(),
    disableInput: vi.fn(),
    setPresented: vi.fn(() => true),
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

export function updatePanel(
  panel: DesktopPanelController,
  changes: Partial<DesktopPanelController>,
): void {
  for (const key of Object.keys(changes) as (keyof DesktopPanelController)[]) {
    const previous = panel[key];
    if (Object.is(previous, changes[key])) {
      continue;
    }
    Object.assign(panel, { [key]: changes[key] });
    panel.inputsChanged(key, previous);
  }
}

export function mountPanel(panel: DesktopPanelController): void {
  document.body.append(panel.element);
  mountedPanels.set(
    panel,
    mountSolid(() => createComponent(DesktopPanelContent, { controller: panel }), {
      container: panel.element,
    }),
  );
  flush();
}

export function unmountPanel(panel: DesktopPanelController): void {
  mountedPanels.get(panel)?.unmount();
  mountedPanels.delete(panel);
  panel.element.remove();
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
