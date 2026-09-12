import { ContextProvider } from "@lit/context";
import type { GatewayEventFrame, GatewayEventListener } from "../api/gateway.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../app/context.ts";
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

export function createApplicationContextProvider(context: ApplicationContext<RouteId>) {
  const host = document.createElement("div");
  const normalize = (value: ApplicationContext<RouteId>) => {
    if (!value.sidebarAttention) {
      Object.assign(value, { sidebarAttention: emptySidebarAttentionStore });
    }
    return value;
  };
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: normalize(context),
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext<RouteId>) => provider.setValue(normalize(value)),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;

export function createApplicationGateway(initial: ApplicationGatewaySnapshot) {
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
    publish(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}
