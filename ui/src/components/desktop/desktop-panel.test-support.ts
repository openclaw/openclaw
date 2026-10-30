import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";
import "./desktop-panel-solid.tsx";

type Panel = HTMLElementTagNameMap["openclaw-desktop-panel"];

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
  },
} satisfies EnvironmentSummary;

export function createPanel() {
  const panel = document.createElement("openclaw-desktop-panel");
  panel.sessions = {
    describe: (params, options) =>
      expectDefined(options?.client ?? panel.client, "Desktop fixture Gateway client").request(
        "sessions.describe",
        params,
      ),
  };
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

export function clickPanelButton(panel: Panel, selector = ".desktop-environment button") {
  expectDefined(
    panel.querySelector<HTMLButtonElement>(selector),
    `Desktop element: ${selector}`,
  ).click();
}

export const sizingMenu = (panel: Panel) =>
  expectDefined(panel.querySelector<HTMLSelectElement>(".desktop-sizing"), "Desktop sizing menu");

export function selectSizing(panel: Panel, mode: string): void {
  const menu = sizingMenu(panel);
  menu.value = mode;
  menu.dispatchEvent(new Event("change", { bubbles: true }));
}

export function updatePanel(panel: Panel, changes: Partial<Panel>): void {
  Object.assign(panel, changes);
}

export async function mountPanel(panel: Panel): Promise<void> {
  document.body.append(panel);
  await panel.updateComplete;
  flush();
}

export async function unmountPanel(panel: Panel): Promise<void> {
  panel.remove();
  await Promise.resolve();
  flush();
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
