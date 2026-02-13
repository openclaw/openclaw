import { describe, expect, it, vi } from "vitest";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";

type TestSocket = {
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
};

describe("gateway broadcaster", () => {
  it("filters approval and pairing events by scope", () => {
    const approvalsSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const pairingSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const readSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };

    const clients = new Set<GatewayWsClient>([
      {
        socket: approvalsSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.approvals"] } as GatewayWsClient["connect"],
        connId: "c-approvals",
      },
      {
        socket: pairingSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        connId: "c-pairing",
      },
      {
        socket: readSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        connId: "c-read",
      },
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-read"]));
    expect(readSocket.send).toHaveBeenCalledTimes(1);
    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
  });

  it("does not increment seq when all clients are slow with dropIfSlow (#12895)", () => {
    const slowSocket: TestSocket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const clients = new Set<GatewayWsClient>([
      {
        socket: slowSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: [] } as GatewayWsClient["connect"],
        connId: "c-slow",
      },
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    // First broadcast: all clients slow + dropIfSlow → seq should NOT increment
    broadcast("tick", { ts: 1 }, { dropIfSlow: true });
    expect(slowSocket.send).not.toHaveBeenCalled();

    // Make client fast again
    slowSocket.bufferedAmount = 0;
    broadcast("tick", { ts: 2 });

    // The seq in the frame should be 1 (not 2), proving the slow-dropped
    // broadcast did not consume a seq number.
    const frame = JSON.parse((slowSocket.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(frame.seq).toBe(1);
  });

  it("delivers contiguous seq to fast clients when mixed with slow (#12895)", () => {
    const fastSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const slowSocket: TestSocket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const clients = new Set<GatewayWsClient>([
      {
        socket: fastSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: [] } as GatewayWsClient["connect"],
        connId: "c-fast",
      },
      {
        socket: slowSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: [] } as GatewayWsClient["connect"],
        connId: "c-slow",
      },
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("tick", { ts: 1 }, { dropIfSlow: true });
    broadcast("tick", { ts: 2 }, { dropIfSlow: true });

    const calls = (fastSocket.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const seq1 = JSON.parse(calls[0][0]).seq;
    const seq2 = JSON.parse(calls[1][0]).seq;
    expect(seq2 - seq1).toBe(1);
  });
});
