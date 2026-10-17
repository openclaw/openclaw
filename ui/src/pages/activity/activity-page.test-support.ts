import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";

export function activityHello(recoveryScope = "activity-owner-a"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: ["operator.read"], recoveryScope },
  };
}

export function createActivityGatewayStub(): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  // SAFETY: Static route tests only read the snapshot and register these observers.
  return {
    snapshot,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn(() => () => undefined),
    subscribeEventLog: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

export function inspectorGateway(client: GatewayBrowserClient) {
  const source = createActivityGatewayStub();
  Object.assign(source.snapshot, {
    client,
    phase: "connected",
    hello: {
      ...activityHello(),
      features: { methods: ["audit.run.inspect"], events: [] },
    },
  });
  return source;
}

export function activityRoster(
  sessions: GatewaySessionRow[] = [
    { key: "main", kind: "direct", hasActiveRun: true },
    { key: "agent:other:work", kind: "direct", hasActiveRun: true },
  ],
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    sessions,
    defaults: { model: null, modelProvider: null, contextTokens: null },
  };
}

export function activityResponse(method: string, params: unknown) {
  switch (method) {
    case "sessions.list":
      return activityRoster();
    case "sessions.subscribe":
      return { subscribed: true };
    case "sessions.messages.subscribe":
      return params;
    default:
      return {};
  }
}
