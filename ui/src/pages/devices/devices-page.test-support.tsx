import { createSignal, flush } from "solid-js";
import { vi } from "vitest";
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
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { DevicesPage, type DevicesRouteData } from "./devices-page.tsx";

export const gatewayPresence: PresenceEntry = { mode: "gateway", host: "Gateway host", ts: 1_000 };
export const cleanups: Array<() => void> = [];

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
  const routeListeners = new Set<() => void>();
  const context = {
    get gateway() {
      return currentGateway();
    },
    basePath: "",
    router: {
      subscribe: (listener: () => void) => {
        routeListeners.add(listener);
        return () => {
          routeListeners.delete(listener);
        };
      },
    },
    runtimeConfig: {
      state: { configSnapshot: {}, configForm: {}, configLoading: false, configFormMode: "form" },
      subscribe: () => () => undefined,
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
    container.remove();
    flush();
  };
  cleanups.push(dispose);
  return {
    container,
    config: context.runtimeConfig.state,
    dispose,
    leaveRoute() {
      for (const listener of routeListeners) {
        listener();
      }
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
