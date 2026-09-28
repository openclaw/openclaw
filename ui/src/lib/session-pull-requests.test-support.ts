import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "./session-pull-requests.ts";

export function createHello(): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
  };
}

export function createGatewayHarness() {
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ subscribed: true });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: createHello(),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const unsubscribeSnapshots = vi.fn();
  const unsubscribeEvents = vi.fn();
  const subscribeSnapshots = vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
    snapshotListeners.add(listener);
    return () => {
      unsubscribeSnapshots();
      snapshotListeners.delete(listener);
    };
  });
  const subscribeEvents = vi.fn((listener: GatewayEventListener) => {
    eventListeners.add(listener);
    return () => {
      unsubscribeEvents();
      eventListeners.delete(listener);
    };
  });
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: subscribeSnapshots,
    subscribeEvents,
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as ApplicationGateway;
  return {
    gateway,
    request,
    subscribeSnapshots,
    subscribeEvents,
    unsubscribeSnapshots,
    unsubscribeEvents,
    emit(payload: unknown, event = "controlUi.sessionPullRequests.changed") {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event,
          payload,
          seq: 1,
        });
      }
    },
    setSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  };
}

export async function flushSync() {
  await Promise.resolve();
  await Promise.resolve();
}
