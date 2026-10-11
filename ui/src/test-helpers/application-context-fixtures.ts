import type { GatewayEventFrame, GatewayEventListener } from "../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context-types.ts";
import type { MentionsCapability } from "../app/mentions.ts";

export const hiddenScopeUpgradeCapability = {
  state: { phase: "hidden" as const },
  activate: () => undefined,
  request: () => undefined,
  retry: () => undefined,
  cancel: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["scopeUpgrade"];

const unavailableMentionsCapability = {
  snapshot: { phase: "unavailable", items: [], dismissing: [], error: null },
  refresh: async () => undefined,
  dismiss: async () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies MentionsCapability;

const emptySidebarAttentionStore = {
  entries: [],
  activate: () => unavailableMentionsCapability,
  dismiss: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["sidebarAttention"];

export function normalizeApplicationContext(value: ApplicationContext): ApplicationContext {
  if (!value.sidebarAttention) {
    Object.assign(value, { sidebarAttention: emptySidebarAttentionStore });
  }
  return value;
}

export function createApplicationGateway(
  initial: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "",
    lastError: null,
    lastErrorCode: null,
  },
) {
  let snapshot = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const gateway = {
    connectionRevision: 0,
    connection: { gatewayUrl: "ws://gateway.example.test", token: "", password: "" },
    get snapshot() {
      return snapshot;
    },
    connect: () => undefined,
    subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publishEvent: (event: GatewayEventFrame) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    publish(this: void, next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

export function createNavigationPreferencesFixture(): ApplicationContext["navigation"] {
  let snapshot: ApplicationContext["navigation"]["snapshot"] = {
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    navigationScope: "mine",
    pinnedAgentIds: [],
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
