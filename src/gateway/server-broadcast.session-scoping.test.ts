import { describe, it, expect, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createMockClient(overrides: {
  connId: string;
  scopes?: string[];
  chatSessionKeys?: Set<string>;
}): GatewayWsClient {
  const sent: string[] = [];
  return {
    connId: overrides.connId,
    socket: {
      send: vi.fn((data: string) => sent.push(data)),
      close: vi.fn(),
      bufferedAmount: 0,
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
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

    broadcast("chat", { sessionKey: "session-1", text: "hello" });

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

    broadcast("chat", { sessionKey: "session-1", text: "hello" });

    // Client A subscribed to session-1 → receives event
    expect(getSentPayloads(clientA)).toHaveLength(1);
    // Client B subscribed to session-2 only → does NOT receive event
    expect(getSentPayloads(clientB)).toHaveLength(0);
  });

  it("always delivers chat events to admin-scoped clients regardless of session tracking", () => {
    const adminClient = createMockClient({
      connId: "admin",
      scopes: ["operator.admin"],
      chatSessionKeys: new Set(["session-2"]), // subscribed to different session
    });
    const regularClient = createMockClient({
      connId: "regular",
      chatSessionKeys: new Set(["session-2"]),
    });
    const clients = new Set([adminClient, regularClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", text: "hello" });

    // Admin always receives all chat events
    expect(getSentPayloads(adminClient)).toHaveLength(1);
    // Regular client subscribed to session-2 → does NOT receive session-1 events
    expect(getSentPayloads(regularClient)).toHaveLength(0);
  });

  it("delivers to clients with empty chatSessionKeys (backward compat)", () => {
    const legacyClient = createMockClient({ connId: "legacy" }); // no chatSessionKeys
    const scopedClient = createMockClient({
      connId: "scoped",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clients = new Set([legacyClient, scopedClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-2", text: "hello" });

    // Legacy client (no session tracking) gets everything
    expect(getSentPayloads(legacyClient)).toHaveLength(1);
    // Scoped client subscribed to session-1 → does NOT get session-2
    expect(getSentPayloads(scopedClient)).toHaveLength(0);
  });

  it("does NOT treat admin scope on non-operator role as admin", () => {
    const nodeClient = createMockClient({
      connId: "node",
      scopes: ["operator.admin"],
      chatSessionKeys: new Set(["session-2"]),
    });
    // Override role to "node" — admin scope should not apply
    (nodeClient.connect as Record<string, unknown>).role = "node";
    const clients = new Set([nodeClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", text: "hello" });

    // Non-operator role with admin scope should NOT bypass session scoping
    expect(getSentPayloads(nodeClient)).toHaveLength(0);
  });

  it("does NOT scope non-chat events", () => {
    const clientA = createMockClient({
      connId: "a",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clients = new Set([clientA]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("agent", { sessionKey: "session-2", data: "tool output" });

    // Agent events are NOT session-scoped — client receives it regardless
    expect(getSentPayloads(clientA)).toHaveLength(1);
  });

  it("delivers chat events with no sessionKey to all clients", () => {
    const scopedClient = createMockClient({
      connId: "scoped",
      chatSessionKeys: new Set(["session-1"]),
    });
    const clients = new Set([scopedClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { text: "no session key" }); // no sessionKey in payload

    // Cannot scope without sessionKey → deliver to all
    expect(getSentPayloads(scopedClient)).toHaveLength(1);
  });

  it("client tracking multiple sessions receives events from all of them", () => {
    const multiClient = createMockClient({
      connId: "multi",
      chatSessionKeys: new Set(["session-1", "session-2"]),
    });
    const clients = new Set([multiClient]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "session-1", text: "msg1" });
    broadcast("chat", { sessionKey: "session-2", text: "msg2" });
    broadcast("chat", { sessionKey: "session-3", text: "msg3" });

    // Receives session-1 and session-2, not session-3
    expect(getSentPayloads(multiClient)).toHaveLength(2);
  });
});
