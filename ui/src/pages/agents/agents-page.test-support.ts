import { flush } from "solid-js";
import { afterEach, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesListResult, AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createAgentsPageState } from "./agents-page-state.ts";
import type { AgentsRouteData } from "./route.ts";

const AGENTS_PAGE_GATEWAY_HELLO = gatewayHelloForMethods([
  "config.patch",
  "config.set",
  "agents.update",
  "cron.list",
  "cron.status",
]);

const pages = new Set<() => void>();
type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
type GatewayEventListener = Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
const gatewayListeners = new WeakMap<ApplicationContext["gateway"], Set<GatewayListener>>();

afterEach(() => pages.forEach((dispose) => dispose()));

function fillMissing(target: object, defaults: object) {
  for (const [key, value] of Object.entries(defaults)) {
    if (Reflect.get(target, key) === undefined) {
      Reflect.set(target, key, value);
    }
  }
}

/** Mount the same owner used by the page; fixtures only supply its external capabilities. */
export function createAgentsPage(context: ApplicationContext, routeData?: AgentsRouteData) {
  // Capability builders own their stubs; fill only missing page projection fields here.
  const subscribe = () => () => {};
  fillMissing(context, {
    basePath: "",
    config: { current: { assistantIdentity: {} }, subscribe },
    navigation: { snapshot: { pinnedAgentIds: [] }, subscribe },
  });
  fillMissing(context.runtimeConfig, {
    state: context.runtimeConfig.state ?? createInitialConfigState(),
    ensureLoaded: context.runtimeConfig.ensureLoaded ?? (async () => {}),
  });
  fillMissing(context.channels, { state: context.channels.state ?? {} });
  let state!: ReturnType<typeof createAgentsPageState>;
  const mounted = mountSolid(() => {
    state = createAgentsPageState(context, routeData);
    return document.createElement("openclaw-agents-page");
  });
  flush();
  const dispose = () => {
    pages.delete(dispose);
    mounted.unmount();
  };
  pages.add(dispose);
  return {
    read: () => state.read(),
    setRouteData(next?: AgentsRouteData) {
      state.setRouteData(next);
      flush();
    },
    dispose,
  };
}

export function emitGatewaySnapshot(
  currentGateway: ApplicationContext["gateway"],
  next: ApplicationGatewaySnapshot,
) {
  createGatewayMetadataObserver((current) => current === next).synchronize(
    currentGateway.snapshot,
    next,
  );
  Object.assign(currentGateway, { snapshot: next });
  for (const notify of gatewayListeners.get(currentGateway) ?? []) {
    notify(next);
  }
  flush();
}

export function snapshot(
  client: GatewayBrowserClient | null,
  connected = true,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: AGENTS_PAGE_GATEWAY_HELLO,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

const eventListeners = new WeakMap<ApplicationContext["gateway"], Set<GatewayEventListener>>();

export function emitCatalogChanged(currentGateway: ApplicationContext["gateway"]) {
  const client = currentGateway.snapshot.client;
  if (client) {
    invalidateChatMetadataStore(client);
  }
  for (const listener of eventListeners.get(currentGateway) ?? []) {
    listener({ type: "event", event: "chat.metadata.changed", payload: {} });
  }
}

export function gateway(current: ApplicationGatewaySnapshot): ApplicationContext["gateway"] {
  const listeners = new Set<GatewayEventListener>();
  const snapshots = new Set<GatewayListener>();
  const result = {
    connection: { gatewayUrl: "ws://settings.test" },
    subscribeEvents: (listener: GatewayEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: current,
    subscribe: vi.fn((notify: GatewayListener) => {
      snapshots.add(notify);
      return () => snapshots.delete(notify);
    }),
  } as unknown as ApplicationContext["gateway"];
  eventListeners.set(result, listeners);
  gatewayListeners.set(result, snapshots);
  return result;
}

export function settingsSelection(
  agentsList: AgentsListResult | null,
  selectedId: string | null = "main",
) {
  const selection = createAgentSelectionCapability(
    {
      connection: { gatewayUrl: "ws://settings.test" },
      snapshot: { assistantAgentId: "main" },
      subscribe: () => () => undefined,
    },
    { state: { agentsList }, subscribe: () => () => undefined },
    undefined,
    undefined,
    { requireConfiguredAgent: true },
  );
  selection.set(selectedId);
  return selection;
}

export const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", name: "Main" }],
};

export function agentsRouteData(
  currentGateway: ApplicationContext["gateway"],
  roster: AgentsListResult | null = agentsList,
  requestedAgentId: string | null = "main",
  selection: ApplicationContext["settingsAgentSelection"] = settingsSelection(roster),
): AgentsRouteData {
  const pathname = requestedAgentId ? `/settings/agents/${requestedAgentId}` : "/settings/agents";
  return {
    gateway: currentGateway,
    gatewaySnapshot: currentGateway.snapshot,
    location: { pathname, search: "", hash: "" },
    requestedAgentId,
    settingsAgentSelection: selection,
    selectionIntentRevision: selection.intentRevision,
    panel: "files",
    agentsList: roster,
  };
}

export function agentsCapability(ensureFiles: () => Promise<AgentsFilesListResult>) {
  return {
    state: {
      client: null,
      connected: true,
      agentsLoading: false,
      agentsError: null,
      agentsList,
    },
    files: () => ({ list: null, loading: false, error: null }),
    ensureList: vi.fn(async () => agentsList),
    refreshList: vi.fn(async () => agentsList),
    ensureFiles,
    refreshFiles: ensureFiles,
    recordFile: () => {},
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["agents"];
}

export function pageContext(
  currentGateway: ApplicationContext["gateway"],
  agents: ApplicationContext["agents"],
  options?: Partial<Pick<ApplicationContext, "agentIdentity" | "sessions">>,
): ApplicationContext {
  const subscribe = vi.fn(() => () => undefined);
  return {
    gateway: currentGateway,
    agents,
    settingsAgentSelection: settingsSelection(agents.state.agentsList),
    router: { getState: () => ({ matches: [{ routeId: "agents" }], pendingMatches: [] }) },
    navigate: vi.fn(),
    replace: vi.fn(),
    agentIdentity: options?.agentIdentity ?? {
      get: () => ({ agentId: "main" }),
      entries: () => [],
      ensure: vi.fn(async () => undefined),
      subscribe,
    },
    sessions: options?.sessions ?? {
      state: { result: null, modelOverrides: {} },
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { subscribe },
  } as unknown as ApplicationContext;
}
