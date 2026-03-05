import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PeerRegistry } from "./peer-registry.js";
import type { PeerSession } from "./types.js";

function createMockSocket() {
  const send = vi.fn();
  const close = vi.fn();
  return {
    socket: { send, close, readyState: 1 } as unknown as PeerSession["socket"],
    send,
    close,
  };
}

function createSession(
  overrides: Partial<PeerSession & { _send?: ReturnType<typeof vi.fn> }> = {},
) {
  const { socket: s, send } = createMockSocket();
  const session: PeerSession = {
    deviceId: "peer-a",
    connId: "conn-1",
    displayName: "Test Peer",
    publicKey: "pk-a",
    socket: overrides.socket ?? s,
    outbound: false,
    capabilities: ["channel:telegram"],
    connectedAtMs: Date.now(),
    ...overrides,
  };
  return { session, send: overrides.socket ? null : send };
}

describe("PeerRegistry", () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = new PeerRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("register()", () => {
    it("stores a peer session", () => {
      const { session } = createSession();
      registry.register(session);
      expect(registry.get("peer-a")).toBe(session);
    });

    it("with duplicate deviceId closes old connId mapping and stores new", () => {
      const { session: oldSession } = createSession({ connId: "conn-old" });
      registry.register(oldSession);

      const { session: newSession } = createSession({ connId: "conn-new" });
      registry.register(newSession);

      expect(registry.get("peer-a")).toBe(newSession);
      expect(registry.getByConnId("conn-old")).toBeUndefined();
      expect(registry.getByConnId("conn-new")).toBe(newSession);
    });
  });

  describe("unregister()", () => {
    it("removes peer by connId", () => {
      const { session } = createSession();
      registry.register(session);
      const result = registry.unregister("conn-1");
      expect(result).toBe("peer-a");
      expect(registry.get("peer-a")).toBeUndefined();
    });

    it("returns null for unknown connId", () => {
      expect(registry.unregister("unknown")).toBeNull();
    });

    it("fails pending RPCs with PEER_DISCONNECTED error", async () => {
      const { session } = createSession();
      registry.register(session);

      // Start an RPC that will pend
      const rpcPromise = registry.invoke({
        deviceId: "peer-a",
        method: "test.method",
        timeoutMs: 5000,
      });

      // Disconnect the peer
      registry.unregister("conn-1");

      const result = await rpcPromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("PEER_DISCONNECTED");
    });
  });

  describe("get()", () => {
    it("returns session by deviceId", () => {
      const { session } = createSession();
      registry.register(session);
      expect(registry.get("peer-a")).toBe(session);
    });

    it("returns undefined for unknown deviceId", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("getByConnId()", () => {
    it("returns session by connId", () => {
      const { session } = createSession();
      registry.register(session);
      expect(registry.getByConnId("conn-1")).toBe(session);
    });

    it("returns undefined for unknown connId", () => {
      expect(registry.getByConnId("unknown")).toBeUndefined();
    });
  });

  describe("listConnected()", () => {
    it("returns all connected peers", () => {
      const { session: s1 } = createSession({ deviceId: "peer-a", connId: "c1" });
      const { session: s2 } = createSession({ deviceId: "peer-b", connId: "c2" });
      registry.register(s1);
      registry.register(s2);
      const peers = registry.listConnected();
      expect(peers).toHaveLength(2);
      expect(peers.map((p) => p.deviceId).toSorted()).toEqual(["peer-a", "peer-b"]);
    });

    it("returns empty array when no peers", () => {
      expect(registry.listConnected()).toEqual([]);
    });
  });

  describe("broadcastEvent()", () => {
    it("sends event to all connected peers", () => {
      const m1 = createMockSocket();
      const m2 = createMockSocket();
      const { session: s1 } = createSession({
        deviceId: "peer-a",
        connId: "c1",
        socket: m1.socket,
      });
      const { session: s2 } = createSession({
        deviceId: "peer-b",
        connId: "c2",
        socket: m2.socket,
      });
      registry.register(s1);
      registry.register(s2);

      registry.broadcastEvent("mesh.test", { foo: "bar" });

      expect(m1.send).toHaveBeenCalledOnce();
      expect(m2.send).toHaveBeenCalledOnce();
      const sent1 = JSON.parse(m1.send.mock.calls[0][0] as string);
      expect(sent1).toEqual({ type: "event", event: "mesh.test", payload: { foo: "bar" } });
    });
  });

  describe("sendEvent()", () => {
    it("sends event to specific peer", () => {
      const m = createMockSocket();
      const { session } = createSession({ deviceId: "peer-a", connId: "c1", socket: m.socket });
      registry.register(session);
      const ok = registry.sendEvent("peer-a", "mesh.ping", { ts: 1 });
      expect(ok).toBe(true);
      expect(m.send).toHaveBeenCalledOnce();
    });

    it("returns false for unknown peer", () => {
      expect(registry.sendEvent("unknown", "mesh.ping")).toBe(false);
    });
  });

  describe("invoke()", () => {
    it("returns NOT_CONNECTED for unknown peer", async () => {
      const result = await registry.invoke({ deviceId: "unknown", method: "test" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("NOT_CONNECTED");
    });

    it("returns SEND_FAILED when socket.send throws", async () => {
      const m = createMockSocket();
      m.send.mockImplementation(() => {
        throw new Error("socket closed");
      });
      const { session } = createSession({ deviceId: "peer-a", connId: "c1", socket: m.socket });
      registry.register(session);
      const result = await registry.invoke({ deviceId: "peer-a", method: "test" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("SEND_FAILED");
    });
  });

  describe("handleRpcResult()", () => {
    it("routes response to pending RPC", async () => {
      const m = createMockSocket();
      const { session } = createSession({ deviceId: "peer-a", connId: "c1", socket: m.socket });
      registry.register(session);

      const rpcPromise = registry.invoke({
        deviceId: "peer-a",
        method: "test.method",
        timeoutMs: 5000,
      });

      // Extract the request ID from the sent frame
      const sentFrame = JSON.parse(m.send.mock.calls[0][0] as string);

      // Send back a result
      const handled = registry.handleRpcResult({
        id: sentFrame.id,
        ok: true,
        payload: { result: "success" },
      });
      expect(handled).toBe(true);

      const result = await rpcPromise;
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ result: "success" });
    });

    it("returns false for unknown request ID", () => {
      expect(registry.handleRpcResult({ id: "unknown", ok: true })).toBe(false);
    });
  });
});
