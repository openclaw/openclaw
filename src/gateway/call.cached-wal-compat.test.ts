import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { callGatewayFromCliRuntime } from "../cli/gateway-rpc.runtime.js";

type RequestFrame = { type: "req"; id: string; method: string; params?: unknown };

// Keep the CLI facade, one-shot call owner, and GatewayClient protocol real.
// Only the socket peer is synthetic, so no Gateway process or network is needed.
class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: RequestFrame[] = [];

  constructor() {
    super();
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
    this.receive({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "cached-wal-compat-fixture", ts: Date.now() },
    });
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw) as RequestFrame);
  }

  receive(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }

  respond(request: RequestFrame, payload: unknown) {
    this.receive({ type: "res", id: request.id, ok: true, payload });
  }

  reject(request: RequestFrame, code: string, message: string) {
    this.receive({ type: "res", id: request.id, ok: false, error: { code, message } });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close();
  }
}

// mock-isolation: Replace only the network peer; the real client owns framing and lifecycle.
vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: MockWebSocket,
}));
// mock-isolation: Keep process-wide operator proxy state outside the socket fixture.
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  ensureInheritedManagedProxyRoutingActive: vi.fn(),
  registerManagedProxyGatewayLoopbackBypass: vi.fn(),
}));

let callFromCli: typeof callGatewayFromCliRuntime;
const calls: Promise<unknown>[] = [];

beforeAll(async () => {
  ({ callGatewayFromCliRuntime: callFromCli } = await import("../cli/gateway-rpc.runtime.js"));
});

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
});

afterEach(async () => {
  for (const socket of MockWebSocket.instances) {
    socket.close();
  }
  await Promise.allSettled(calls.splice(0));
  const timers = vi.getTimerCount();
  vi.useRealTimers();
  expect(timers).toBe(0);
});

async function beginCall() {
  const pending = callFromCli(
    "status.sqliteWal",
    {
      url: "ws://127.0.0.1:18789",
      token: "cached-wal-compat-fixture-token",
      config: {},
      json: true,
      timeout: "1000",
    },
    {},
    { deviceIdentity: null, sharedStateMode: "read-only", scopes: ["operator.read"] },
  );
  // Register rejection ownership before the peer can send an error frame.
  void pending.catch(() => {});
  calls.push(pending);
  // The real readiness owner requires two low-drift clock checks before IO.
  await vi.advanceTimersByTimeAsync(2);
  expect(MockWebSocket.instances).toHaveLength(1);
  const socket = MockWebSocket.instances[0];
  assert(socket);
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent.map((request) => request.method)).toEqual(["connect"]);
  const connect = socket.sent[0];
  assert(connect);
  return { pending, socket, connect };
}

function hello(features?: { methods: string[]; events: string[] }) {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: { version: "old6-fixture", connId: "cached-wal-compat-fixture" },
    ...(features ? { features } : {}),
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
    },
    auth: { role: "operator", scopes: ["operator.read"] },
    policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 30_000 },
  };
}

function applicationRequests() {
  return MockWebSocket.instances.flatMap((socket) =>
    socket.sent.filter((request) => request.method !== "connect"),
  );
}

describe("cached WAL CLI capability check through the real Gateway transport", () => {
  it.each([
    undefined,
    { methods: ["health", "status"], events: [] },
    { methods: ["status", "status.sqliteWal.extra"], events: [] },
  ])("rejects an old HELLO without sending an application request: %j", async (features) => {
    const { pending, socket, connect } = await beginCall();
    socket.respond(connect, hello(features));
    await vi.advanceTimersByTimeAsync(0);

    expect(applicationRequests()).toEqual([]);
    await expect(pending).rejects.toThrow(
      'active gateway does not support required method "status.sqliteWal"',
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(3);
  });

  it("sends exactly the advertised cached method and returns its response", async () => {
    const { pending, socket, connect } = await beginCall();
    socket.respond(connect, hello({ methods: ["status", "status.sqliteWal"], events: [] }));
    await vi.advanceTimersByTimeAsync(0);

    expect(applicationRequests()).toEqual([
      { type: "req", id: expect.any(String), method: "status.sqliteWal", params: {} },
    ]);
    const request = applicationRequests()[0];
    assert(request);
    const payload = { fixture: "cached-wal-response" };
    socket.respond(request, payload);

    await expect(pending).resolves.toEqual(payload);
    expect(socket.sent.map((frame) => frame.method)).toEqual(["connect", "status.sqliteWal"]);
  });

  it("preserves a connect rejection without requesting status or the cached method", async () => {
    const { pending, socket, connect } = await beginCall();
    socket.reject(connect, "INVALID_REQUEST", "cached-wal fixture connect rejected");
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).rejects.toMatchObject({
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      message: "cached-wal fixture connect rejected",
    });
    expect(applicationRequests()).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("preserves the pre-HELLO deadline without an application request or fallback", async () => {
    const { pending } = await beginCall();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).rejects.toMatchObject({
      name: "GatewayTransportError",
      kind: "timeout",
      timeoutMs: 1000,
    });
    await expect(pending).rejects.not.toThrow("The request was already sent");
    expect(applicationRequests()).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it.each(["rejection", "timeout"] as const)(
    "keeps a cached-method %s without retrying the ordinary status method",
    async (failure) => {
      const { pending, socket, connect } = await beginCall();
      socket.respond(connect, hello({ methods: ["status", "status.sqliteWal"], events: [] }));
      await vi.advanceTimersByTimeAsync(0);
      const request = applicationRequests()[0];
      assert(request);

      if (failure === "rejection") {
        socket.reject(request, "UNAVAILABLE", "cached-wal fixture unavailable");
        await expect(pending).rejects.toMatchObject({
          name: "GatewayClientRequestError",
          gatewayCode: "UNAVAILABLE",
          message: "cached-wal fixture unavailable",
        });
      } else {
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).rejects.toMatchObject({
          name: "GatewayTransportError",
          kind: "timeout",
          timeoutMs: 1000,
        });
        await expect(pending).rejects.toThrow("The request was already sent");
      }

      expect(socket.sent.map((frame) => frame.method)).toEqual(["connect", "status.sqliteWal"]);
      expect(MockWebSocket.instances).toHaveLength(1);
    },
  );
});
