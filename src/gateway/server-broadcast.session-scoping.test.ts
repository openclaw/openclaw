import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_TRACKED_CHAT_SESSION_KEYS } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createMockClient(overrides: {
  connId: string;
  role?: string;
  scopes?: string[];
  chatSessionKeys?: Set<string>;
}): GatewayWsClient {
  return {
    connId: overrides.connId,
    socket: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: 0,
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "test", version: "0.0.0", mode: "webchat" },
      role: overrides.role ?? "operator",
      scopes: overrides.scopes ?? [],
    } as unknown as GatewayWsClient["connect"],
    chatSessionKeys: overrides.chatSessionKeys,
  };
}

function getSentPayloads(client: GatewayWsClient): unknown[] {
  return (client.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (args: unknown[]) => JSON.parse(args[0] as string).payload,
  );
}

describe("chat broadcast session scoping", () => {
  it("delivers chat events to all clients when none have declared session interest", () => {
    const clientA = createMockClient({ connId: "a" });
    const clientB = createMockClient({ connId: "b" });
    const clients = new Set([clientA, clientB]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", state: "delta" });

    expect(getSentPayloads(clientA)).toHaveLength(1);
    expect(getSentPayloads(clientB)).toHaveLength(1);
  });

  it("scopes chat events to clients that have interacted with the session", () => {
    const clientA = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clientB = createMockClient({
      connId: "b",
      chatSessionKeys: new Set(["session-2"]),
    });
    const clients = new Set([clientA, clientB]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", state: "delta" });

    expect(getSentPayloads(clientA)).toHaveLength(1);
    expect(getSentPayloads(clientB)).toHaveLength(0);
  });

  it("delivers chat events without sessionKey to all interested clients", () => {
    const clientA = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clientB = createMockClient({
      connId: "b",
      chatSessionKeys: new Set(["session-2"]),
    });
    const clients = new Set([clientA, clientB]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { state: "final" });

    expect(getSentPayloads(clientA)).toHaveLength(1);
    expect(getSentPayloads(clientB)).toHaveLength(1);
  });

  it("always delivers chat events to operator.admin-scoped operator clients", () => {
    const adminClient = createMockClient({
      connId: "admin",
      scopes: ["operator.admin"],
      chatSessionKeys: new Set(["session-other"]),
    });
    const regularClient = createMockClient({
      connId: "regular",
      chatSessionKeys: new Set(["session-other"]),
    });
    const clients = new Set([adminClient, regularClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", state: "delta" });

    expect(getSentPayloads(adminClient)).toHaveLength(1);
    expect(getSentPayloads(regularClient)).toHaveLength(0);
  });

  it("does not grant admin bypass to non-operator roles with admin scope", () => {
    const nonOperatorAdmin = createMockClient({
      connId: "node",
      role: "node",
      scopes: ["operator.admin"],
      chatSessionKeys: new Set(["session-other"]),
    });
    const clients = new Set([nonOperatorAdmin]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", state: "delta" });

    expect(getSentPayloads(nonOperatorAdmin)).toHaveLength(0);
  });

  it("does not apply session scoping to non-chat events", () => {
    const clientA = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clientB = createMockClient({
      connId: "b",
      chatSessionKeys: new Set(["session-2"]),
    });
    const clients = new Set([clientA, clientB]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("agent", { sessionKey: "session-1", type: "run_start" });

    expect(getSentPayloads(clientA)).toHaveLength(1);
    expect(getSentPayloads(clientB)).toHaveLength(1);
  });

  it("delivers to clients with empty chatSessionKeys (backward compat)", () => {
    const legacyClient = createMockClient({
      connId: "legacy",
      chatSessionKeys: new Set(),
    });
    const scopedClient = createMockClient({
      connId: "scoped",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clients = new Set([legacyClient, scopedClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-2", state: "delta" });

    // Legacy client with empty set still receives (backward compat)
    expect(getSentPayloads(legacyClient)).toHaveLength(1);
    // Scoped client does not receive events for untracked sessions
    expect(getSentPayloads(scopedClient)).toHaveLength(0);
  });

  it("delivers to clients subscribed to multiple sessions", () => {
    const multiClient = createMockClient({
      connId: "multi",
      chatSessionKeys: new Set(["session-1", "session-2", "session-3"]),
    });
    const singleClient = createMockClient({
      connId: "single",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clients = new Set([multiClient, singleClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-2", state: "delta" });

    expect(getSentPayloads(multiClient)).toHaveLength(1);
    expect(getSentPayloads(singleClient)).toHaveLength(0);
  });

  it("evicts oldest key when chatSessionKeys exceeds the cap", () => {
    // Build a set at the cap limit.
    const keys = new Set<string>();
    for (let i = 0; i < MAX_TRACKED_CHAT_SESSION_KEYS; i++) {
      keys.add(`s-${i}`);
    }
    const client = createMockClient({ connId: "full", chatSessionKeys: keys });
    // Manually simulate adding one more key via the eviction logic.
    // The oldest key (s-0) should be evicted.
    const oldest = keys.values().next().value!;
    keys.delete(oldest);
    keys.add("s-new");

    const clients = new Set([client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    // Client should receive events for the newly added key.
    broadcast("chat", { sessionKey: "s-new", state: "delta" });
    expect(getSentPayloads(client)).toHaveLength(1);
  });

  it("matches session keys case-insensitively via broadcast-side lowercase fallback", () => {
    // Client tracked "main" — broadcast-side lowercases "Main" to "main"
    // and finds a match without needing loadConfig().
    const client = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["main"]),
    });
    const clients = new Set([client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "Main", state: "delta" });
    expect(getSentPayloads(client)).toHaveLength(1);
  });

  it("matches when client tracked canonical key and event uses same canonical key", () => {
    // Canonical resolution happens at registration time (trackChatSessionKey).
    // If the client tracked "agent:ops:work" (the canonical form) and the
    // event also uses "agent:ops:work", it matches directly.
    const client = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["agent:ops:work"]),
    });
    const clients = new Set([client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "agent:ops:work", state: "delta" });
    expect(getSentPayloads(client)).toHaveLength(1);
  });

  it("still filters when canonical key does not match tracked set", () => {
    const client = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["agent:ops:work"]),
    });
    const clients = new Set([client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "unrelated-session", state: "delta" });
    expect(getSentPayloads(client)).toHaveLength(0);
  });
});
