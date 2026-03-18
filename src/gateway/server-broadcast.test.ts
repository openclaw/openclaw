import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ConnectParams } from "./protocol/index.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// Suppress ws-log output during tests.
vi.mock("./ws-log.js", () => ({
  logWs: vi.fn(),
  shouldLogWs: () => false,
  summarizeAgentEventForWsLog: vi.fn(),
}));

function makeClient(
  connId: string,
  overrides?: { sendThrows?: boolean; bufferedAmount?: number; scopes?: string[] },
): GatewayWsClient {
  const send = overrides?.sendThrows
    ? vi.fn(() => {
        throw new Error("send failed");
      })
    : vi.fn();
  return {
    connId,
    socket: {
      send,
      close: vi.fn(),
      bufferedAmount: overrides?.bufferedAmount ?? 0,
    } as unknown as WebSocket,
    connect: {
      role: "operator",
      scopes: overrides?.scopes ?? [],
    } as ConnectParams,
  };
}

/** Helper: parse the seq field from the last `send` call on a client. */
function lastSentSeq(client: GatewayWsClient): number | undefined {
  const sendFn = client.socket.send as ReturnType<typeof vi.fn>;
  const lastCall = sendFn.mock.calls.at(-1);
  if (!lastCall) return undefined;
  return JSON.parse(lastCall[0] as string).seq;
}

/** Helper: collect all seq values sent to a client. */
function allSentSeqs(client: GatewayWsClient): (number | undefined)[] {
  const sendFn = client.socket.send as ReturnType<typeof vi.fn>;
  return sendFn.mock.calls.map((call) => JSON.parse(call[0] as string).seq);
}

describe("createGatewayBroadcaster", () => {
  describe("per-client seq counters", () => {
    it("new clients start at seq 1", () => {
      const clients = new Set<GatewayWsClient>();
      const c = makeClient("c1");
      clients.add(c);
      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast("test.event", {});

      expect(lastSentSeq(c)).toBe(1);
    });

    it("each client gets its own independent seq counter", () => {
      const clients = new Set<GatewayWsClient>();
      const c1 = makeClient("c1");
      const c2 = makeClient("c2");
      clients.add(c1);
      const { broadcast } = createGatewayBroadcaster({ clients });

      // Send two events to c1 only.
      broadcast("e1", {});
      broadcast("e2", {});

      // Now add c2 and send a third event.
      clients.add(c2);
      broadcast("e3", {});

      // c1 should be at seq 3; c2 should start at seq 1.
      expect(allSentSeqs(c1)).toEqual([1, 2, 3]);
      expect(allSentSeqs(c2)).toEqual([1]);
    });

    it("increments seq only after a successful send", () => {
      const clients = new Set<GatewayWsClient>();
      // First client sends fine, second throws on send.
      const good = makeClient("good");
      const bad = makeClient("bad", { sendThrows: true });
      clients.add(good);
      clients.add(bad);
      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast("e1", {});
      broadcast("e2", {});

      // Good client: seq 1, 2.
      expect(allSentSeqs(good)).toEqual([1, 2]);

      // Bad client: send was attempted with seq 1 both times (counter never
      // advanced because send threw before the increment).
      const badSend = bad.socket.send as ReturnType<typeof vi.fn>;
      expect(badSend).toHaveBeenCalledTimes(2);
      // Both attempted sends should carry seq 1 since the counter never moved.
      const attemptedSeqs = badSend.mock.calls.map((call) => JSON.parse(call[0] as string).seq);
      expect(attemptedSeqs).toEqual([1, 1]);
    });

    it("does not assign seq for targeted (broadcastToConnIds) events", () => {
      const clients = new Set<GatewayWsClient>();
      const c = makeClient("c1");
      clients.add(c);
      const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

      // Targeted send should have seq undefined.
      broadcastToConnIds("targeted.event", { data: 1 }, new Set(["c1"]));
      expect(lastSentSeq(c)).toBeUndefined();

      // Subsequent broadcast should still start at 1 (targeted didn't consume a seq).
      broadcast("broadcast.event", {});
      expect(lastSentSeq(c)).toBe(1);
    });

    it("skips slow consumers without advancing their seq", () => {
      const clients = new Set<GatewayWsClient>();
      // Slow client with dropIfSlow behavior.
      const slow = makeClient("slow", { bufferedAmount: 100 * 1024 * 1024 });
      const normal = makeClient("normal");
      clients.add(slow);
      clients.add(normal);
      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast("e1", {}, { dropIfSlow: true });

      // Normal client got seq 1; slow client was skipped (no send).
      expect(allSentSeqs(normal)).toEqual([1]);
      const slowSend = slow.socket.send as ReturnType<typeof vi.fn>;
      expect(slowSend).not.toHaveBeenCalled();
    });

    it("recovers seq after a failed send followed by a successful one", () => {
      const clients = new Set<GatewayWsClient>();
      const c = makeClient("c1");
      clients.add(c);
      const { broadcast } = createGatewayBroadcaster({ clients });

      // First send succeeds.
      broadcast("e1", {});
      expect(lastSentSeq(c)).toBe(1);

      // Make send fail for the next call.
      const sendFn = c.socket.send as ReturnType<typeof vi.fn>;
      sendFn.mockImplementationOnce(() => {
        throw new Error("transient failure");
      });
      broadcast("e2", {});

      // Restore normal send behavior and broadcast again.
      broadcast("e3", {});

      // seq should be 1, then attempted 2 (failed), then 2 again (succeeded).
      // Total successful sends: e1 (seq 1) and e3 (seq 2). The failed e2
      // attempted seq 2 but didn't increment the counter.
      expect(lastSentSeq(c)).toBe(2);
    });
  });
});
