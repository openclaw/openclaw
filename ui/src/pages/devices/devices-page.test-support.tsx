import { expectDefined } from "@openclaw/normalization-core";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import {
  createInitialDevicesState,
  type DevicesPageDataState,
} from "../../lib/nodes/page-operations.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  deviceSystemInfo,
  deviceDesktopEnvironments,
} from "../../test-helpers/devices-fixtures.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DevicesPage } from "./devices-page.tsx";
import type { DevicesRouteData } from "./view.types.ts";

const gatewayPresence: PresenceEntry = { mode: "gateway", host: "Gateway host", ts: 1_000 };
const pairedDevice = {
  deviceId: "device-1",
  displayName: "MacBook Pro",
  tokens: [{ role: "operator", scopes: [] }],
};
export let dialogs: ReturnType<typeof createModalDialogTestFixture>;
export const cleanups: Array<() => void> = [];

export function stubLocalDeviceIdentity() {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({
      version: 1,
      deviceId: "00",
      publicKey: "AA",
      privateKey: "AA",
    }),
  );
  vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array([0]).buffer } });
}

export function gatewaySnapshot(
  client: GatewayBrowserClient | null,
  connected = true,
  methods: string[] = [],
  scopes = ["operator.read", "operator.pairing"],
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes },
      features: { methods },
      snapshot: { presence: [gatewayPresence] },
    },
  } as ApplicationGatewaySnapshot;
}

export function gatewayFixture(initial: ApplicationGatewaySnapshot) {
  let snapshot = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const source = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "http://gateway.test" },
    subscribe: vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    subscribeEvents: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
  } as unknown as ApplicationContext["gateway"];
  return {
    source,
    emitSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
      flush();
    },
    emitEvent(event: string, payload?: unknown) {
      for (const listener of eventListeners) {
        listener({ event, payload });
      }
      flush();
    },
    get subscriptions() {
      return listeners.size + eventListeners.size;
    },
  };
}

export function mountPage(
  fixture: ReturnType<typeof gatewayFixture>,
  initial: Partial<DevicesPageDataState> = {},
  routeOverride?: Partial<DevicesRouteData>,
  runtimeConfig?: ApplicationContext["runtimeConfig"],
) {
  const snapshot = fixture.source.snapshot;
  const routeData: DevicesRouteData = {
    gateway: fixture.source,
    gatewaySnapshot: snapshot,
    devices: {
      ...createInitialDevicesState({
        client: snapshot.client,
        connected: snapshot.phase === "connected",
      }),
      ...initial,
    },
    ...routeOverride,
  };
  const [currentGateway, setGateway] = createSignal(fixture.source);
  const [presentation, setPresentation] = createSignal({ routeData });
  const configListeners = new Set<() => void>();
  const reloadConfig = vi.fn(async () => undefined);
  const router = createRouter({
    routes: [
      definePage({ id: "devices", path: "/devices", component: () => ({}) }),
      definePage({ id: "usage", path: "/usage", component: () => ({}) }),
    ],
  });
  const context = {
    get gateway() {
      return currentGateway();
    },
    basePath: "",
    router,
    runtimeConfig: runtimeConfig ?? {
      state: { configSnapshot: {}, configForm: {}, configLoading: false, configFormMode: "form" },
      subscribe: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
      discardDraft: reloadConfig,
    },
  } as unknown as ApplicationContext;
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = mountSolid(
    () => (
      <ApplicationProvider value={context}>
        <DevicesPage routeData={presentation().routeData} />
      </ApplicationProvider>
    ),
    { container },
  );
  flush();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    mounted.unmount();
    router.stop();
    container.remove();
    flush();
  };
  cleanups.push(dispose);
  return {
    container,
    config: context.runtimeConfig.state,
    reloadConfig,
    publishConfig: () => configListeners.forEach((listener) => listener()),
    router,
    dispose,
    leaveRoute() {
      void router.navigate("usage", {});
      flush();
    },
    refreshPresentation() {
      setPresentation({ routeData });
      flush();
    },
    replaceGateway(next: ReturnType<typeof gatewayFixture>) {
      setGateway(next.source);
      flush();
    },
  };
}

export function responseFor(method: string): unknown {
  if (method === "system-presence") {
    return [gatewayPresence];
  }
  if (method === "system.info") {
    return deviceSystemInfo;
  }
  if (method === "environments.list") {
    return { environments: deviceDesktopEnvironments };
  }
  if (method === "exec.approvals.get") {
    return {
      path: "/synthetic/exec-approvals.json",
      exists: true,
      hash: "initial",
      file: { version: 1 },
    };
  }
  return { nodes: [], paired: [], pending: [] };
}

export function clientFor(request = vi.fn(async (method: string) => responseFor(method))) {
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

export function button(container: ParentNode, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`Expected ${label} button`);
  }
  return found;
}

export function dialogButton(label: string) {
  const modal = document.body.querySelector("openclaw-modal-dialog");
  if (!modal) {
    throw new Error("Expected an open dialog");
  }
  return button(modal, label);
}

export async function selectEntryAction(
  container: ParentNode,
  action: string,
  name = "MacBook Pro",
) {
  // Let initial native readiness settle before keeping an interactive row reference.
  await waitForSolid(() => expect(container.textContent).toContain(name));
  const row = [...container.querySelectorAll(".device-entry")].find(
    (entry) => entry.querySelector(".settings-row__title")?.textContent === name,
  );
  const trigger = expectDefined(
    row?.querySelector<HTMLButtonElement>(".device-entry__menu-trigger"),
    "device actions trigger",
  );
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  expectDefined(
    row?.querySelector<HTMLButtonElement>(`[role="menuitem"][data-value="${action}"]`),
    `device action ${action}`,
  ).click();
  await Promise.resolve();
  flush();
}

export function secretDialogText() {
  return document.body.querySelector(".secret-reveal__code")?.textContent?.trim() ?? "";
}

export async function expectNoModal() {
  await vi.waitFor(() => expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull());
}

export function mountPaired(request: Parameters<typeof clientFor>[0]) {
  const { client } = clientFor(request);
  const fixture = gatewayFixture(gatewaySnapshot(client));
  const page = mountPage(fixture, {
    devicesList: { paired: [pairedDevice], pending: [] },
    nodes: [{ nodeId: "node-1", displayName: "Office Mac" }],
  });
  return { ...page, fixture, client };
}

export function rotatingRequest(token: string | null) {
  return dialogs.mockRequest(async (method: string, params?: unknown) => {
    if (method !== "device.token.rotate") {
      return responseFor(method);
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    return {
      deviceId,
      role,
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      ...(token ? { token } : {}),
      tokenDelivery: token ? "in-band" : "withheld-cross-device",
    };
  });
}

export function setupDevicesPageFixtures() {
  beforeEach(() => {
    dialogs = createModalDialogTestFixture((modal) => {
      const acknowledge = modal.querySelector<HTMLButtonElement>(
        ".exec-approval-actions button[autofocus]",
      );
      if (acknowledge) {
        acknowledge.click();
      } else {
        modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      }
    });
  });
  afterEach(async () => {
    try {
      for (const dispose of cleanups.splice(0)) {
        dispose();
      }
      await dialogs.cleanup();
    } finally {
      localStorage.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
}
