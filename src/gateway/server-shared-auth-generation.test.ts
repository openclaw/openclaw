import { describe, expect, it, vi } from "vitest";
import {
  disconnectAllSharedGatewayAuthClients,
  disconnectStaleSharedGatewayAuthClients,
  type SharedGatewayAuthClient,
} from "./server-shared-auth-generation.js";

type MockedClient = SharedGatewayAuthClient & {
  socket: {
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
};

function makeClient(params: {
  connId: string;
  usesSharedGatewayAuth?: boolean;
  generation?: string;
  closeImpl?: (code: number, reason: string) => void;
  terminateImpl?: () => void;
}): MockedClient {
  return {
    connId: params.connId,
    usesSharedGatewayAuth: params.usesSharedGatewayAuth ?? true,
    sharedGatewaySessionGeneration: params.generation ?? "gen-stale",
    socket: {
      close: vi.fn(params.closeImpl),
      terminate: vi.fn(params.terminateImpl),
    },
  };
}

describe("disconnectAllSharedGatewayAuthClients", () => {
  it("logs, falls back to terminate, and keeps evicting remaining clients when close throws", () => {
    const warn = vi.fn();
    const closeError = Object.assign(new Error("socket already destroyed"), {
      code: "ERR_SOCKET_CLOSED",
    });

    const throwing = makeClient({
      connId: "conn-bad",
      closeImpl: () => {
        throw closeError;
      },
    });
    const healthy = makeClient({ connId: "conn-good" });
    const skippedNonShared = makeClient({
      connId: "conn-skip",
      usesSharedGatewayAuth: false,
    });

    disconnectAllSharedGatewayAuthClients([throwing, healthy, skippedNonShared], { warn });

    expect(throwing.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(throwing.socket.terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connId=conn-bad"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket already destroyed"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("attempting terminate()"));

    expect(healthy.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(healthy.socket.terminate).not.toHaveBeenCalled();

    expect(skippedNonShared.socket.close).not.toHaveBeenCalled();
    expect(skippedNonShared.socket.terminate).not.toHaveBeenCalled();
  });

  it("swallows terminate() failures so the eviction loop still continues", () => {
    const warn = vi.fn();
    const throwing = makeClient({
      connId: "conn-terminate-throws",
      closeImpl: () => {
        throw new Error("close failed");
      },
      terminateImpl: () => {
        throw new Error("terminate failed too");
      },
    });
    const healthy = makeClient({ connId: "conn-good" });

    expect(() =>
      disconnectAllSharedGatewayAuthClients([throwing, healthy], { warn }),
    ).not.toThrow();

    expect(throwing.socket.terminate).toHaveBeenCalledTimes(1);
    expect(healthy.socket.close).toHaveBeenCalledTimes(1);
  });
});

describe("disconnectStaleSharedGatewayAuthClients", () => {
  it("skips clients whose generation already matches, evicts the rest, and logs close failures", () => {
    const warn = vi.fn();

    const stale = makeClient({
      connId: "conn-stale",
      generation: "gen-old",
      closeImpl: () => {
        throw new Error("EPIPE");
      },
    });
    const alreadyCurrent = makeClient({
      connId: "conn-current",
      generation: "gen-new",
    });
    const staleHealthy = makeClient({
      connId: "conn-stale-healthy",
      generation: "gen-old",
    });

    disconnectStaleSharedGatewayAuthClients({
      clients: [stale, alreadyCurrent, staleHealthy],
      expectedGeneration: "gen-new",
      logger: { warn },
    });

    expect(stale.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(stale.socket.terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connId=conn-stale"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));

    expect(alreadyCurrent.socket.close).not.toHaveBeenCalled();
    expect(alreadyCurrent.socket.terminate).not.toHaveBeenCalled();

    expect(staleHealthy.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
    expect(staleHealthy.socket.terminate).not.toHaveBeenCalled();
  });

  it("stays silent (no logger) when none is provided and close succeeds", () => {
    const client = makeClient({ connId: "conn-a", generation: "gen-old" });
    expect(() =>
      disconnectStaleSharedGatewayAuthClients({
        clients: [client],
        expectedGeneration: "gen-new",
      }),
    ).not.toThrow();
    expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
  });
});
