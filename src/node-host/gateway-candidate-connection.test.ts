import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientCloseInfo, GatewayClientOptions } from "../gateway/client.js";
import { createNodeHostGatewayCandidateConnection } from "./gateway-candidate-connection.js";

const mocks = vi.hoisted(() => {
  const createClient = (options: GatewayClientOptions) => ({
    request: vi.fn(async () => ({ url: options.url })),
    start: vi.fn(),
    stop: vi.fn(),
    stopAndWait: vi.fn(async () => {}),
    updateNodeManifest: vi.fn(),
  });
  return {
    createClient,
    options: [] as GatewayClientOptions[],
    clients: [] as ReturnType<typeof createClient>[],
  };
});

// mock-isolation: Control candidate connection callbacks without opening real Gateway sockets.
vi.mock("../gateway/client.js", () => ({
  GatewayClient: function GatewayClient(options: GatewayClientOptions) {
    const client = mocks.createClient(options);
    mocks.options.push(options);
    mocks.clients.push(client);
    return client;
  },
}));

const candidates = [
  { host: "192.168.1.20", port: 18789, contextPath: "/openclaw-gw", tls: false },
  { host: "gateway.tailnet.example", port: 443, tls: true },
];
const manifest = { caps: ["mcp"], commands: ["mcp.tools.call.v1"] };
const callbacks = {
  onEvent: vi.fn(),
  onHelloOk: vi.fn(),
  onConnectError: vi.fn(),
  onReconnectPaused: vi.fn(),
  onClose: vi.fn(),
  onWinningCandidate: vi.fn(),
};

function closeCandidate(
  overrides: Partial<GatewayClientCloseInfo> = {},
  reason = "transport unavailable",
  code = 1006,
) {
  mocks.options[0]?.onClose?.(code, reason, {
    phase: "pre-hello",
    socketOpened: false,
    transportValidated: false,
    connectRequestSent: false,
    transientPreHelloCleanClose: false,
    ...overrides,
  });
}

function createConnection(
  cloudflareAccessByCandidate?: Parameters<
    typeof createNodeHostGatewayCandidateConnection
  >[0]["cloudflareAccessByCandidate"],
) {
  return createNodeHostGatewayCandidateConnection({
    candidates,
    clientOptions: {},
    cloudflareAccessByCandidate,
    ...callbacks,
  });
}

describe("gateway candidate connection", () => {
  beforeEach(() => {
    mocks.options.length = 0;
    mocks.clients.length = 0;
    vi.clearAllMocks();
  });

  it("rotates only before hello, fences stale callbacks, and forwards through the winner", async () => {
    const connection = createConnection();
    connection.start();

    expect(mocks.options[0]?.url).toBe("ws://192.168.1.20:18789/openclaw-gw");
    expect(mocks.clients[0]?.start).toHaveBeenCalledOnce();
    connection.updateNodeManifest(manifest);
    closeCandidate();
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
    const [first, winner] = mocks.clients;

    expect(first?.stop).toHaveBeenCalledOnce();
    expect(mocks.options[1]?.url).toBe("wss://gateway.tailnet.example:443");
    expect(winner?.start).toHaveBeenCalledOnce();
    expect(winner?.updateNodeManifest).toHaveBeenCalledWith(manifest);

    mocks.options[0]?.onEvent?.({ type: "event", event: "stale" });
    mocks.options[0]?.onHelloOk?.({} as never);
    closeCandidate({}, "stale close");
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onHelloOk).not.toHaveBeenCalled();
    expect(callbacks.onWinningCandidate).not.toHaveBeenCalled();
    expect(mocks.clients).toHaveLength(2);

    const activeEvent = { type: "event", event: "active" } as const;
    mocks.options[1]?.onEvent?.(activeEvent);
    mocks.options[1]?.onHelloOk?.({} as never);
    mocks.options[1]?.onHelloOk?.({} as never);
    expect(callbacks.onEvent).toHaveBeenCalledWith(activeEvent);
    expect(callbacks.onWinningCandidate).toHaveBeenCalledOnce();
    expect(callbacks.onWinningCandidate).toHaveBeenCalledWith(candidates[1]);

    await connection.request("node.test", { active: true }, undefined);
    connection.updateNodeManifest(manifest);
    expect(first?.request).not.toHaveBeenCalled();
    expect(winner?.request).toHaveBeenCalledWith("node.test", { active: true }, undefined);
    expect(winner?.updateNodeManifest).toHaveBeenCalledWith(manifest);
  });

  it("does not rotate after the connect request was sent", async () => {
    createConnection();

    closeCandidate(
      { socketOpened: true, transportValidated: true, connectRequestSent: true },
      "connect failed",
      1008,
    );
    await Promise.resolve();

    expect(mocks.clients).toHaveLength(1);
  });

  it("promotes a candidate after hello instead of replaying setup auth on another endpoint", async () => {
    createConnection();

    mocks.options[0]?.onHelloOk?.({} as never);
    closeCandidate({}, "later reconnect transport failure");
    await Promise.resolve();

    expect(callbacks.onWinningCandidate).toHaveBeenCalledWith(candidates[0]);
    expect(mocks.clients).toHaveLength(1);
  });

  it.each([false, true])("cannot start candidates after stop (queued=%s)", async (queued) => {
    const connection = createConnection();
    if (queued) {
      closeCandidate();
    }
    await connection.stop();
    connection.start();
    await Promise.resolve();
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0]?.start).not.toHaveBeenCalled();
  });

  it("preserves a retired candidate's drain failure during shutdown", async () => {
    const connection = createConnection();
    closeCandidate();
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
    const retiredFailure = new Error("retired candidate storage failed");
    mocks.clients[0]?.stopAndWait.mockRejectedValueOnce(retiredFailure);

    await expect(Promise.resolve(connection.stop())).rejects.toBe(retiredFailure);
    await expect(connection.stop()).rejects.toBe(retiredFailure);
    expect(mocks.clients[0]?.stopAndWait).toHaveBeenCalledOnce();
    expect(mocks.clients[1]?.stopAndWait).toHaveBeenCalledOnce();
  });

  it("never carries origin-bound Access credentials to another candidate host", async () => {
    const credentials = { clientId: "test-key", clientSecret: "test-secret" };
    createConnection(new Map([[candidates[0]!, credentials]]));

    expect(mocks.options[0]?.edgeAuthHeaders).toEqual({
      "CF-Access-Client-Id": credentials.clientId,
      "CF-Access-Client-Secret": credentials.clientSecret,
    });
    closeCandidate();
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));

    expect(mocks.options[1]?.url).toBe("wss://gateway.tailnet.example:443");
    expect(mocks.options[1]?.edgeAuthHeaders).toBeUndefined();
  });
});
