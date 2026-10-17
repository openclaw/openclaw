import { onTestFinished } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createSessionCapability } from "./index.ts";
import type { SessionGateway } from "./session-capability.ts";

function listeners<T>() {
  const callbacks = new Set<(value: T) => void>();
  return {
    subscribe(callback: (value: T) => void) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    emit(value: T) {
      for (const callback of callbacks) {
        callback(value);
      }
    },
  };
}

export function createTestSessionCapability(gateway: SessionGateway, selectedId = "main") {
  const sessions = createSessionCapability(gateway, {
    state: { selectedId },
    subscribe: () => () => undefined,
  });
  const dispose = sessions.dispose;
  let disposed = false;
  sessions.dispose = () => {
    dispose();
    disposed = true;
  };
  onTestFinished(() => {
    if (!disposed) {
      dispose();
    }
  });
  return sessions;
}

export function sessionsResult(
  sessions: SessionsListResult["sessions"],
  ts: number,
): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

export function runningSessionsResult(): SessionsListResult {
  return sessionsResult(
    [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        status: "running",
        startedAt: 1,
      },
    ],
    1,
  );
}

export function createGatewayHarness(
  client: GatewayBrowserClient,
  featureMethods?: string[],
  options?: { selfUser?: { readonly id: string } | null },
) {
  let snapshot: {
    client: GatewayBrowserClient | null;
    phase: "connected" | "reconnecting";
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
    selfUser: { readonly id: string } | null;
  } = {
    client,
    phase: "connected" as const,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello:
      featureMethods === undefined
        ? null
        : ({ features: { methods: featureMethods } } as GatewayHelloOk),
    selfUser: options?.selfUser ?? null,
  };
  const changes = listeners<typeof snapshot>();
  const events = listeners<GatewayEventFrame>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: changes.subscribe,
      subscribeEvents: events.subscribe,
    },
    emitEvent: events.emit,
    publish: (connected: boolean, nextClient: GatewayBrowserClient | null = snapshot.client) => {
      snapshot = {
        ...snapshot,
        client: nextClient,
        phase: connected ? "connected" : "reconnecting",
      };
      changes.emit(snapshot);
    },
  };
}

export function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, reason: "create", key, kind: "direct", updatedAt: 1 },
  };
}

export function createSessionCapabilityHarness(
  request: GatewayBrowserClient["request"],
  options?: { ownerId?: string },
) {
  const { gateway, emitEvent } = createGatewayHarness(
    { request } as GatewayBrowserClient,
    undefined,
    {
      selfUser: options?.ownerId ? { id: options.ownerId } : null,
    },
  );
  return { sessions: createTestSessionCapability(gateway), emitEvent };
}

export function createSubscriptionHydrationHarness(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  savedAgentId: string | null = null,
) {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    client: null as GatewayBrowserClient | null,
    phase: "reconnecting" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: null as string | null,
    hello: null as GatewayHelloOk | null,
  };
  const changes = listeners<typeof snapshot>();
  const events = listeners<GatewayEventFrame>();
  const publish = () => changes.emit(snapshot);
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.example.test" },
    get snapshot() {
      return snapshot;
    },
    subscribe: changes.subscribe,
    subscribeEvents: events.subscribe,
    setSessionKey(sessionKey: string) {
      snapshot = { ...snapshot, sessionKey };
      publish();
    },
  };
  const selection = createAgentSelectionCapability(
    gateway,
    {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: ["main", "writer"].map((id) => ({ id, kind: "agent" as const })),
        },
      },
      subscribe: () => () => undefined,
    },
    { load: () => savedAgentId, save: () => undefined },
  );
  const sessions = createSessionCapability(gateway, selection);
  return {
    client,
    gateway,
    selection,
    sessions,
    emitEvent: events.emit,
    connect: () => {
      snapshot = { ...snapshot, client, phase: "connected", assistantAgentId: "main" };
      publish();
    },
    disconnect: () => {
      snapshot = { ...snapshot, phase: "reconnecting" };
      publish();
    },
  };
}
