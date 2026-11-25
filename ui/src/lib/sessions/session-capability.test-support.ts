import { onTestFinished } from "vitest";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createSessionCapability } from "./index.ts";
import type { SessionGateway } from "./session-capability.ts";

type Snapshot = {
  client: GatewayBrowserClient | null;
  phase: "connected" | "reconnecting";
  sessionKey: string;
  assistantAgentId: string | null;
  hello: GatewayHelloOk | null;
  selfUser: { readonly id: string } | null;
};

export function createGatewayHarness(
  client: GatewayBrowserClient,
  featureMethods?: string[],
  options?: { selfUser?: Snapshot["selfUser"]; initial?: Partial<Snapshot> },
) {
  let snapshot: Snapshot = {
    client,
    phase: "connected",
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: featureMethods ? ({ features: { methods: featureMethods } } as GatewayHelloOk) : null,
    selfUser: options?.selfUser ?? null,
    ...options?.initial,
  };
  const changes = new Set<(next: Snapshot) => void>();
  const events = new Set<(event: GatewayEventFrame) => void>();
  const update = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    changes.forEach((listener) => listener(snapshot));
  };
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (next: Snapshot) => void) => registerListener(changes, listener),
      subscribeEvents: (listener: (event: GatewayEventFrame) => void) =>
        registerListener(events, listener),
    },
    update,
    publish: (connected: boolean, nextClient = snapshot.client) =>
      update({ client: nextClient, phase: connected ? "connected" : "reconnecting" }),
    emitEvent: (event: GatewayEventFrame) => events.forEach((listener) => listener(event)),
  };
}

export function createTestSessionCapability(gateway: SessionGateway, selectedId = "main") {
  const selection = { state: { selectedId }, subscribe: () => () => undefined };
  const sessions = createSessionCapability(gateway, selection);
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

export function sessionsResult(rows: SessionsListResult["sessions"], ts = 1): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

export function runningSessionsResult(): SessionsListResult {
  return sessionsResult([
    {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: ["run-1"],
      status: "running",
      startedAt: 1,
    },
  ]);
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
  { ownerId }: { ownerId?: string } = {},
) {
  const { gateway, emitEvent } = createGatewayHarness(
    { request } as GatewayBrowserClient,
    undefined,
    { selfUser: ownerId ? { id: ownerId } : null },
  );
  return { sessions: createTestSessionCapability(gateway), emitEvent };
}

export function createSubscriptionHydrationHarness(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  savedAgentId: string | null = null,
) {
  const client = { request } as GatewayBrowserClient;
  const h = createGatewayHarness(client, undefined, {
    initial: { client: null, phase: "reconnecting", assistantAgentId: null },
  });
  const gateway = Object.assign(h.gateway, {
    connection: { gatewayUrl: "ws://gateway.example.test" },
    setSessionKey(sessionKey: string) {
      h.update({ sessionKey });
    },
  });
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
    emitEvent: h.emitEvent,
    connect: () => h.update({ client, phase: "connected", assistantAgentId: "main" }),
    disconnect: () => h.update({ phase: "reconnecting" }),
  };
}
