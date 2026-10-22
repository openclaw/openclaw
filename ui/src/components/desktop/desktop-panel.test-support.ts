import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { DesktopClient, DesktopConnectionHandle } from "./desktop-client.ts";
import "./desktop-panel.ts";

type Panel = HTMLElementTagNameMap["openclaw-desktop-panel"];

export function usePanelStorage() {
  beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
}

export function connectedClient(
  overrides: Partial<DesktopConnectionHandle> = {},
  authenticate = true,
) {
  return vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    if (authenticate) {
      options.onConnect?.();
    }
    return createConnectionHandle(overrides);
  });
}

export async function waitForConnections(panel: Panel, connect: unknown, count = 1) {
  await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(count));
  await panel.updateComplete;
}

export async function updateAndSettle(panel: Panel, changes: Partial<Panel>) {
  updatePanel(panel, changes);
  await panel.updateComplete;
}

export async function mountDesktop(
  client: GatewayBrowserClient,
  connect: DesktopClient["connect"] | undefined,
  options: Partial<Panel> = {},
) {
  const panel = createPanel();
  updatePanel(panel, {
    client,
    available: true,
    ...(connect ? { desktopClientFactory: () => ({ connect }) } : {}),
    ...options,
  });
  await mountPanel(panel);
  return panel;
}

export function rpcCalls<T extends unknown[]>(request: { mock: { calls: T[] } }, method: string) {
  return request.mock.calls.filter(([name]) => name === method);
}

export function expectObserve(request: unknown, environmentId: string, control = false) {
  expect(request).toHaveBeenLastCalledWith("desktop.observe", {
    source: { kind: "environment", environmentId },
    control,
  });
}

export type RpcParams = {
  control?: boolean;
  environmentId?: string;
  credentials?: { username: string; password: string };
};
type Reply = (params?: RpcParams) => unknown;
const observation = (control = false) => ({ transport: "rfb", wsPath: "/view", control });
export function desktopRequest(
  handlers: Record<string, Reply>,
  fallback: Reply = (params) => observation(params?.control),
) {
  return vi.fn(async (method: string, params?: RpcParams) =>
    (handlers[method] ?? fallback)(params),
  );
}

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
  panelElement<HTMLButtonElement>(panel, selector).click();
}

export function panelElement<T extends Element>(panel: Panel, selector: string): T {
  return expectDefined(panel.querySelector<T>(selector), `Desktop element: ${selector}`);
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
