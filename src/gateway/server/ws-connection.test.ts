import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawDataToString } from "../../../packages/gateway-client/src/websocket-data.js";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import { createGatewayBroadcaster as createBroadcaster } from "../server-broadcast.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "../server-constants.js";
import { GatewayClientRegistry } from "./client-registry.js";
import {
  attachGatewayWsForTest as attachForTest,
  createGatewayWsTestLogger as makeLogger,
  createGatewayWsTestRequestContext as makeContext,
  createGatewayWsTestSocket as makeSocket,
  createResolvedGatewayTokenAuth as tokenAuth,
  type GatewayWsTestSocket as TestSocket,
} from "./ws-connection.test-helpers.js";

const {
  attachMessage,
  attachWorker,
  cleanupTalk,
  recordDisconnect,
  touchPresence,
  upsertPresence,
} = vi.hoisted(() => ({
  attachMessage: vi.fn<(params: Handler) => void>(),
  attachWorker: vi.fn((_params: unknown) => vi.fn()),
  cleanupTalk: vi.fn(),
  recordDisconnect: vi.fn(async () => ({ recorded: true })),
  touchPresence: vi.fn(),
  upsertPresence: vi.fn(),
}));

// mock-isolation: Test socket lifecycle without starting message dispatch.
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachMessage,
}));
// mock-isolation: Test worker attachment ownership without starting worker dispatch.
vi.mock("./ws-connection/worker-connection.js", () => ({
  attachWorkerWsMessageHandler: attachWorker,
}));
// mock-isolation: Record disconnection without reading or updating paired-device state.
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeDisconnection: recordDisconnect,
}));
// mock-isolation: Observe presence lifecycle without shared process presence state.
vi.mock("../../infra/system-presence.js", () => ({
  commitPresence: vi.fn(),
  touchPresence,
  upsertPresence,
}));
// mock-isolation: Observe connection cleanup without opening talk sessions.
vi.mock("../talk/session-registry.js", () => ({
  cleanupTalkConnection: cleanupTalk,
}));

import { markPublicWorkerIngress } from "./public-worker-ingress-context.js";
import { attachGatewayWsConnectionHandler as attachConnection } from "./ws-connection.js";
import type { GatewayWsMessageHandlerParams as Handler } from "./ws-connection/message-handler-types.js";
import { resolveSharedGatewaySessionGeneration as sharedGeneration } from "./ws-shared-generation.js";
import { GATEWAY_WS_CONNECTION_KIND_PROPERTY } from "./ws-types.js";
import type { GatewayWsClient as Client } from "./ws-types.js";

const responseFrame = { type: "res", id: "test-request", ok: true };
const operatorConnect: Client["connect"] = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
};
const nodeConnect: Client["connect"] = {
  ...operatorConnect,
  role: "node",
  client: { ...operatorConnect.client, id: "openclaw-macos", mode: "node" },
};
const readableOperator = { ...operatorConnect, role: "operator", scopes: ["operator.read"] };
function device(id: string): NonNullable<Client["connect"]["device"]> {
  return {
    id,
    publicKey: "test-key",
    signature: "test-signature",
    signedAt: 1,
    nonce: "test-nonce",
  };
}
function makeClient(
  socket: TestSocket | Ws.WebSocket,
  connId: string,
  overrides: Partial<Client> = {},
): Client {
  return {
    socket: socket as unknown as Client["socket"],
    connId,
    usesSharedGatewayAuth: false,
    ...overrides,
    connect: { ...operatorConnect, ...overrides.connect },
  };
}

function registerClient(
  handler: Handler,
  socket: Parameters<typeof makeClient>[0],
  overrides?: Parameters<typeof makeClient>[2],
) {
  const client = makeClient(socket, handler.connId, overrides);
  expect(handler.setClient(client)).toBe(true);
  return client;
}

async function openSocketPair() {
  const server = new Ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const accepted = once(server, "connection");
  const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(peer, "open");
  const [socket, request] = (await accepted) as [Ws.WebSocket, IncomingMessage];
  socketCleanups.push(() => closeSocketPair({ server, peer, socket, request }));
  return { server, peer, socket, request };
}

async function closeSocketPair({ server, peer }: Awaited<ReturnType<typeof openSocketPair>>) {
  peer.terminate();
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

let socket: TestSocket;
let clients: GatewayClientRegistry;
let connectionWork: GatewayConnectionWork;
let logWsControl: ReturnType<typeof makeLogger>;
const socketCleanups: Array<() => Promise<void>> = [];

async function connectWs(params: Omit<Parameters<typeof attachForTest>[0], "attach"> = {}) {
  attachForTest({
    attach: attachConnection,
    socket,
    clients,
    ...params,
    options: { connectionWork, ...params.options, logWsControl: logWsControl as never },
  });
  await vi.dynamicImportSettled();
  return attachMessage.mock.calls[0]![0];
}

beforeEach(() => {
  socket = makeSocket();
  clients = new GatewayClientRegistry();
  connectionWork = new GatewayConnectionWork();
  logWsControl = makeLogger();
  setRuntimeConfigSnapshot({});
  attachMessage.mockReset();
  attachWorker.mockClear();
  cleanupTalk.mockReset();
  recordDisconnect.mockReset();
  recordDisconnect.mockResolvedValue({ recorded: true });
  touchPresence.mockReset();
  upsertPresence.mockReset();
});

afterEach(async () => {
  try {
    for (const cleanup of socketCleanups.splice(0)) {
      await cleanup();
    }
  } finally {
    vi.useRealTimers();
    clearRuntimeConfigSnapshot();
  }
});

it("counts accepted event bytes per socket with bounded names and live operator connections", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const observations: DiagnosticEventPayload[] = [];
  const operatorCounts = () =>
    observations
      .filter((event) => event.type === "gateway.ws.connections")
      .map((event) => event.operators);
  setDiagnosticsEnabledForProcess(true);
  const subscribe = () =>
    onInternalDiagnosticEvent((event) => observations.push(event), {
      include: ["gateway.ws.event", "gateway.ws.connections"],
    });
  let unsubscribe = subscribe();
  let stopUntrusted = () => {};
  const first = attachForTest({ attach: attachConnection });
  await vi.dynamicImportSettled();
  expect(attachMessage).toHaveBeenCalledTimes(1);
  const second = makeSocket();
  first.listeners.get("connection")!(second, first.upgradeReq);
  await vi.dynamicImportSettled();
  expect(attachMessage).toHaveBeenCalledTimes(2);
  const handlers = attachMessage.mock.calls.map(([handler]) => handler);
  try {
    for (const [index, metricSocket] of [first.socket, second].entries()) {
      const handler = handlers[index]!;
      registerClient(handler, metricSocket, { connect: readableOperator });
    }
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    expect(operatorCounts()).toEqual([0, 1, 2]);
    const challenges = observations.filter((event) => event.type === "gateway.ws.event");
    expect(challenges.every((event) => event.event === "connect.challenge")).toBe(true);
    expect(challenges.reduce((sum, event) => sum + event.count, 0)).toBe(2);
    observations.length = 0;
    unsubscribe();
    vi.advanceTimersByTime(30_000);
    stopUntrusted = onInternalDiagnosticEvent(() => {}, {
      include: ["gateway.ws.connections"],
      includeTrusted: [],
    });
    unsubscribe = subscribe();
    vi.advanceTimersByTime(30_000);
    const { broadcast } = createBroadcaster({ clients: first.clients });
    broadcast("tick", { text: "é🦞" });
    handlers[0]!.send({
      type: "event",
      event: "private-dynamic-name",
      payload: "private-content",
    });
    handlers[0]!.send({ type: "res", id: "not-an-event", ok: true });
    second.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    broadcast("tick", { text: "only-first" }, { dropIfSlow: true });
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    const events = observations.filter((event) => event.type === "gateway.ws.event");
    expect(events.map(({ event, count }) => ({ event, count }))).toEqual([
      { event: "tick", count: 3 },
      { event: "other", count: 1 },
    ]);
    const firstFrame = first.socket.send.mock.calls.find(([frame]) =>
      String(frame).includes('"event":"tick"'),
    )![0];
    const lastFrame = first.socket.send.mock.lastCall![0];
    const firstBytes =
      typeof firstFrame === "string" ? Buffer.byteLength(firstFrame) : firstFrame.byteLength;
    const lastBytes =
      typeof lastFrame === "string" ? Buffer.byteLength(lastFrame) : lastFrame.byteLength;
    expect(events[0]!.bytes).toBe(2 * firstBytes + lastBytes);
    expect(JSON.stringify(events)).not.toMatch(/private-dynamic-name|private-content|connId/);
    expect(operatorCounts()).toEqual([2]);
    observations.length = 0;
    setDiagnosticsEnabledForProcess(false);
    vi.advanceTimersByTime(30_000);
    await waitForDiagnosticEventsDrained();
    expect(observations).toEqual([]);
    setDiagnosticsEnabledForProcess(true);
    vi.advanceTimersByTime(30_000);
    await waitForDiagnosticEventsDrained();
    expect(operatorCounts()).toEqual([2]);
    observations.length = 0;
    handlers[0]!.close();
    handlers[0]!.close();
    handlers[1]!.close();
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    expect(operatorCounts()).toEqual([1, 0]);
  } finally {
    handlers.forEach((handler) => handler.close());
    first.listeners.get("close")?.();
    unsubscribe();
    stopUntrusted();
    setDiagnosticsEnabledForProcess(false);
  }
});

it("keeps public worker sockets off the legacy challenge and plugin surface", async () => {
  const previous = {
    connId: "worker-previous",
    connect: { client: { id: "openclaw-worker", mode: "worker" }, role: "worker" },
    socket: { terminate: vi.fn() },
    worker: { environmentId: "worker-1" },
  };
  clients = new GatewayClientRegistry([previous] as never);
  const gatewayBudget = { release: vi.fn() };
  const rateLimiter = { check: vi.fn() };
  const getPluginNodeCapabilities = vi.fn(() => [{ surface: "canvas" }]);
  const buildRequestContext = vi.fn(() => makeContext() as never);
  Object.assign(socket, {
    [GATEWAY_WS_CONNECTION_KIND_PROPERTY]: "worker",
    __openclawPreauthBudgetKey: "203.0.113.10",
  });
  markPublicWorkerIngress(socket as never, {
    clientIp: "203.0.113.10",
    rateLimiter: rateLimiter as never,
  });

  attachForTest({
    attach: attachConnection,
    clients,
    socket,
    options: {
      preauthConnectionBudget: gatewayBudget as never,
      getPluginNodeCapabilities,
      buildRequestContext,
    },
  });

  await vi.dynamicImportSettled();
  expect(socket.send).not.toHaveBeenCalled();
  expect(getPluginNodeCapabilities).not.toHaveBeenCalled();
  const handler = attachWorker.mock.calls[0]?.[0] as {
    publicAdmission: { clientIp: string; rateLimiter: unknown };
    setClient(client: never): boolean;
  };
  expect(handler).toMatchObject({
    publicAdmission: { clientIp: "203.0.113.10", rateLimiter },
  });
  const client = {
    connId: "worker-current",
    socket,
    connect: { client: { id: "openclaw-worker", mode: "worker" } },
    worker: { environmentId: "worker-1" },
  };
  expect(handler.setClient(client as never)).toBe(true);
  expect(previous).toMatchObject({ invalidated: true });
  expect(previous.socket.terminate).toHaveBeenCalledOnce();
  expect(new Set(clients)).toEqual(new Set([client]));
  expect(attachMessage).not.toHaveBeenCalled();
  socket.emit("close", 1000, Buffer.alloc(0));
  expect(buildRequestContext).not.toHaveBeenCalled();
  expect(gatewayBudget.release).toHaveBeenCalledWith("203.0.113.10");
});

it("threads current auth getters into the handshake handler instead of a stale snapshot", async () => {
  let currentAuth = tokenAuth("token-before");

  const handler = await connectWs({ options: { getResolvedAuth: () => currentAuth } });

  currentAuth = tokenAuth("token-after");

  expect(handler.getResolvedAuth().token).toBe("token-after");
  expect(handler.getRequiredSharedGatewaySessionGeneration?.()).toBe(sharedGeneration(currentAuth));
});

it.each([
  { capability: "documents", accepted: false },
  { capability: "browser", accepted: true },
])(
  "rechecks $capability node registration after hosted capabilities change",
  async ({ capability, accepted }) => {
    let surfaces: PluginNodeCapabilitySurface[] = [];
    const handler = await connectWs({ options: { getPluginNodeCapabilities: () => surfaces } });

    expect(handler.pluginNodeCapabilities).toEqual([]);
    surfaces = [{ surface: "documents", scopeKey: "publisher:documents" }];
    const node = makeClient(socket, "pending-node", {
      connect: { ...nodeConnect, caps: [capability] },
    });

    try {
      expect(handler.setClient(node)).toBe(accepted);
      if (accepted) {
        expect(new Set(clients)).toEqual(new Set([node]));
        expect(socket.close).not.toHaveBeenCalled();
      } else {
        expect(node).toMatchObject({ invalidated: true });
        expect(clients.size).toBe(0);
        expect(socket.close).toHaveBeenCalledExactlyOnceWith(1012, "node capabilities changed");
        expect(handler.send(responseFrame)).toEqual({ kind: "unavailable" });
      }
    } finally {
      socket.emit("close", 1000, Buffer.from("done"));
    }
  },
);

it("prefers forwarded host over bind host for generic plugin surface URLs", async () => {
  const handler = await connectWs({
    host: "10.0.0.2:18789",
    headers: {
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-host": "gateway.example.com",
      "x-forwarded-proto": "https",
    },
    trustedProxies: ["127.0.0.1"],
    options: {
      gatewayHost: "10.0.0.2",
      port: 18789,
      pluginSurfaceScheme: "http",
      getPluginNodeCapabilities: () => [{ surface: "canvas" }],
    },
  });

  expect(handler.pluginSurfaceBaseUrl).toBe("https://gateway.example.com:443");
});

it("rejects late client registration after a pre-connect socket close", async () => {
  const handler = await connectWs({ clients });

  socket.emit("close", 1001, Buffer.from("client left"));

  expect(handler.setClient(makeClient(socket, "late-client"))).toBe(false);
  expect(clients.size).toBe(0);
});

it("ends delivery subscriptions before connection-owned Talk cleanup", async () => {
  const handler = await connectWs();

  registerClient(handler, socket, { connectionSignal: AbortSignal.abort() });

  const signal = handler.getClient()?.connectionSignal;
  expect(signal?.aborted).toBe(false);
  const closeOrder: string[] = [];
  signal?.addEventListener("abort", () => closeOrder.push("subscription-ended"));
  cleanupTalk.mockImplementation(() => closeOrder.push("talk-cleanup"));

  socket.emit("close", 1000, Buffer.from("done"));

  expect(signal?.aborted).toBe(true);
  expect(closeOrder).toEqual(["subscription-ended", "talk-cleanup"]);
  expect(cleanupTalk).toHaveBeenCalledWith(
    handler.connId,
    expect.objectContaining({ warn: expect.any(Function) }),
  );
});

it.each([
  { delayed: false, pong: true },
  { delayed: true, pong: true },
  { delayed: true, pong: false },
])("keeps the pong deadline ($delayed/$pong)", async ({ delayed, pong }) => {
  vi.useFakeTimers();
  socket = makeSocket({ ping: true });
  let flush: (() => void) | undefined;
  if (delayed) {
    socket.ping?.mockImplementation((_data, _mask, callback) => {
      flush = callback;
    });
  }
  const handler = await connectWs({ socket });
  registerClient(handler, socket, { presenceKey: "ping-client" });
  vi.advanceTimersByTime(25_000);
  expect(socket.ping).toHaveBeenCalledTimes(1);
  expect(touchPresence).not.toHaveBeenCalled();
  if (delayed) {
    socket.bufferedAmount = 4 * 1024 * 1024;
    vi.advanceTimersByTime(24_000);
    socket.bufferedAmount = 0;
    flush?.();
    vi.advanceTimersByTime(1_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(clients.size).toBe(1);
    vi.advanceTimersByTime(23_000);
  }
  if (pong) {
    socket.emit("pong");
    expect(touchPresence).toHaveBeenCalledWith("ping-client");
  }
  vi.advanceTimersByTime(delayed ? 2_000 : 25_000);
  expect(socket.terminate).toHaveBeenCalledTimes(pong ? 0 : 1);
  expect(socket.ping).toHaveBeenCalledTimes(pong ? 2 : 1);
  socket.emit("close", 1000, Buffer.from("done"));
  vi.advanceTimersByTime(25_000);
  expect(socket.ping).toHaveBeenCalledTimes(pong ? 2 : 1);
});

it.each(["direct", "preauth"])("bounds %s shutdown", async (delivery) => {
  vi.useFakeTimers();
  socket.terminate.mockImplementation(() => socket.emit("close", 1006, Buffer.alloc(0)));
  const preauth = delivery === "preauth";
  const handler = await connectWs({ options: preauth ? { preauthHandshakeTimeoutMs: 100 } : {} });
  socket.send.mockClear();
  if (preauth) {
    vi.advanceTimersByTime(100);
    expect(logWsControl.warn.mock.calls[0]?.[0]).toContain("handshake timeout");
    expect(logWsControl.warn.mock.calls[0]?.[0]).toContain("phase=ws_upgrade_started");
  } else {
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    expect(handler.send(responseFrame)).toEqual({ kind: "unavailable" });
  }
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledExactlyOnceWith(
    preauth ? 1000 : 1008,
    preauth ? "" : "slow consumer",
  );
  expect(socket.terminate).not.toHaveBeenCalled();
  const draining = connectionWork.drain();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
  await draining;
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(socket.close.mock.invocationCallOrder[0]).toBeLessThan(
    socket.terminate.mock.invocationCallOrder[0]!,
  );
});

it.each([false, true])(
  "batches a broadcast burst (without vector writes=%s)",
  async (withoutWritev) => {
    const pair = await openSocketPair();
    const { socket: liveSocket, request, peer } = pair;
    if (withoutWritev) {
      // oxlint-disable-next-line no-underscore-dangle -- Exercise Writable's serial fallback on either runtime.
      request.socket._writev = undefined;
    }
    const nativeWrite = vi.spyOn(request.socket, "_write");
    // oxlint-disable-next-line no-underscore-dangle -- Count actual Writable submissions, not public write calls.
    const nativeWritev = request.socket._writev ? vi.spyOn(request.socket, "_writev") : undefined;
    const writes = vi.spyOn(request.socket, "write");
    const { clients: liveClients } = attachForTest({
      attach: attachConnection,
      socket: liveSocket as unknown as TestSocket,
      requestSocket: request.socket,
    });
    await vi.dynamicImportSettled();
    const handler = attachMessage.mock.calls[0]![0];
    registerClient(handler, liveSocket, { connect: readableOperator });
    writes.mockClear();
    nativeWrite.mockClear();
    nativeWritev?.mockClear();
    const received: unknown[] = [];
    const complete = createDeferred();
    peer.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data));
      if (frame.event === "connect.challenge") {
        return;
      }
      received.push(frame);
      if (received.length === 4) {
        complete.resolve();
      }
    });
    const { broadcast } = createBroadcaster({ clients: liveClients });
    broadcast("tick", { value: 1 });
    broadcast("tick", { value: 2 });
    handler.send({ type: "res", id: "between", ok: true });
    broadcast("tick", { value: 3 });
    expect([...liveClients][0]!.socket.bufferedAmount).toBeGreaterThan(0);
    await complete.promise;
    expect(received).toEqual([
      { type: "event", event: "tick", payload: { value: 1 }, seq: 1 },
      { type: "event", event: "tick", payload: { value: 2 }, seq: 2 },
      { type: "res", id: "between", ok: true },
      { type: "event", event: "tick", payload: { value: 3 }, seq: 3 },
    ]);
    const wire = Buffer.concat(writes.mock.calls.map(([chunk]) => Buffer.from(chunk)));
    const expected = [
      '{"type":"event","event":"tick","payload":{"value":1},"seq":1}',
      '{"type":"event","event":"tick","payload":{"value":2},"seq":2}',
      '{"type":"res","id":"between","ok":true}',
      '{"type":"event","event":"tick","payload":{"value":3},"seq":3}',
    ];
    expect(wire).toEqual(
      Buffer.concat(
        expected.flatMap((json) => [Buffer.from([0x81, json.length]), Buffer.from(json)]),
      ),
    );
    expect(nativeWrite.mock.calls.length + (nativeWritev?.mock.calls.length ?? 0)).toBe(1);
    expect([...liveClients][0]!.socket.bufferedAmount).toBe(0);
  },
);

it.each(["closing", "failed-send"] as const)("retires both peers after %s", async (failure) => {
  const pair = await openSocketPair();
  const { socket: liveSocket, peer } = pair;

  const handler = await connectWs({
    socket: liveSocket as unknown as TestSocket,
    requestSocket: pair.request.socket,
  });

  handler.setClient(makeClient(liveSocket, "real-closing-client"));

  if (failure === "closing") {
    liveSocket.close(1000, "real close race");
    expect(liveSocket.readyState).toBe(Ws.WebSocket.CLOSING);
  } else {
    vi.spyOn(pair.request.socket, "write").mockImplementationOnce(() => {
      throw new Error("response transport unavailable");
    });
    vi.spyOn(liveSocket, "close").mockImplementationOnce(() => {
      throw new Error("closing handshake unavailable");
    });
  }
  const bufferedAtClose = liveSocket.bufferedAmount;

  expect(handler.send(responseFrame)).toEqual({ kind: "unavailable" });
  expect(liveSocket.bufferedAmount).toBe(bufferedAtClose);
  expect(clients.size).toBe(0);
  await vi.waitFor(() => expect(peer.readyState).toBe(Ws.WebSocket.CLOSED));
});

it("keeps a closing node discoverable throughout pending lifecycle dispatch and fanout", async () => {
  const unregister = vi.fn(() => "draining-node");
  const get = vi.fn(() => undefined);
  const handler = await connectWs({
    clients,
    socket,
    options: {
      buildRequestContext: () =>
        makeContext({ nodeRegistry: { get, unregister } as never }) as never,
    },
  });

  const nodeClient = makeClient(socket, handler.connId, {
    connect: { ...nodeConnect, minProtocol: 1, maxProtocol: 1, device: device("draining-device") },
  });
  expect(handler.setClient(nodeClient)).toBe(true);
  expect(nodeClient.connectionSignal?.aborted).toBe(false);
  const subscriptionEnded = vi.fn();
  nodeClient.connectionSignal?.addEventListener("abort", subscriptionEnded);
  const healthySocket = makeSocket();
  clients.add(
    makeClient(healthySocket, "healthy-during-node-drain", { connect: readableOperator }),
  );
  const { promise: pending, resolve: releaseDispatch } = createDeferred();
  const dispatch = handler.nodeLifecycleDispatch.dispatch("node.invoke.result", () => pending);
  socket.send.mockClear();
  socket.readyState = Ws.WebSocket.CLOSING;

  expect(handler.send(responseFrame)).toEqual({ kind: "unavailable" });
  expect(clients.has(nodeClient)).toBe(true);
  expect(nodeClient.connectionSignal?.aborted).toBe(true);
  expect(subscriptionEnded).toHaveBeenCalledOnce();
  const broadcaster = createBroadcaster({ clients });
  broadcaster.broadcast("tick", { source: "before-node-close" });

  socket.emit("close", 1000, Buffer.from("node draining"));
  expect(clients.has(nodeClient)).toBe(true);
  expect(unregister).not.toHaveBeenCalled();

  broadcaster.broadcast("tick", { source: "during-node-drain" });

  expect(socket.send).not.toHaveBeenCalled();
  expect(healthySocket.send).toHaveBeenCalledTimes(2);
  const revocableNode = [...clients].find(
    (client) => client.connect.device?.id === "draining-device",
  );
  expect(revocableNode).toBe(nodeClient);
  revocableNode!.invalidated = true;

  releaseDispatch();
  await dispatch;
  await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
  expect(clients.has(nodeClient)).toBe(false);
  expect(subscriptionEnded).toHaveBeenCalledOnce();
});

it("distinguishes serialization failure from unavailable transports", async () => {
  const handler = await connectWs({ socket });

  registerClient(handler, socket, { connId: "failed-response-client" });
  socket.send.mockClear();

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(handler.send(cyclic)).toMatchObject({
    kind: "serialization",
    error: expect.any(TypeError),
  });
  expect(socket.send).not.toHaveBeenCalled();
  expect(clients.size).toBe(1);

  socket.send.mockImplementationOnce(() => {
    throw new Error("socket unavailable");
  });
  expect(handler.send(responseFrame)).toEqual({ kind: "unavailable" });
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(clients.size).toBe(0);

  socket.emit("close", 1000, Buffer.from("done"));
  expect(handler.send({ type: "event", event: "tick" })).toEqual({ kind: "unavailable" });
});

it.each([
  { code: 1001, queued: false },
  { code: 1006, queued: false },
  { code: 1006, queued: true },
])("logs startup close $code (queued=$queued)", async ({ code, queued }) => {
  let startupPending = true;
  const log = makeLogger();
  const { socket: pendingSocket } = attachForTest({
    attach: attachConnection,
    headers: { "user-agent": "OpenClaw/2607000290 CFNetwork/3860 Darwin/25" },
    options: { isStartupPending: () => startupPending, logWsControl: log as never },
  });
  if (queued) {
    pendingSocket.emit("message", Buffer.from('{"type":"req","id":"queued"}'));
  } else {
    await vi.dynamicImportSettled();
    startupPending = false;
  }
  pendingSocket.emit("close", code, Buffer.alloc(0));
  await vi.dynamicImportSettled();
  expect(log[queued ? "warn" : "debug"]).toHaveBeenCalledWith(
    expect.stringContaining("closed before connect"),
    expect.objectContaining({ phase: "ws_upgrade_started" }),
  );
  expect(log[queued ? "debug" : "warn"]).not.toHaveBeenCalledWith(
    expect.stringContaining("closed before connect"),
    expect.anything(),
  );
});

it.each([
  { write: "normal", durationMs: 1_000, cause: undefined, code: 1000 },
  { write: "pending", durationMs: 75_000, cause: "heartbeat-timeout", code: 1006 },
  { write: "completed", durationMs: 50_000, cause: "heartbeat-timeout", code: 1006 },
  { write: "failed", durationMs: 50_000, cause: "heartbeat-timeout", code: 1006 },
  { write: "threw", durationMs: 50_000, cause: "heartbeat-timeout", code: 1006 },
])(
  "records connected close ownership with a $write ping write",
  async ({ write, durationMs, cause, code }) => {
    vi.useFakeTimers();
    socket = makeSocket({ ping: true });
    const callbacks: Array<((error?: Error) => void) | undefined> = [];
    socket.ping?.mockImplementation((_data, _mask, callback?: (error?: Error) => void) => {
      callbacks.push(callback);
      if (write === "threw") {
        throw new Error("private write error");
      }
      if (write === "completed" || write === "failed") {
        callback?.(write === "failed" ? new Error("private write error") : undefined);
      }
    });
    socket.bufferedAmount = 41;
    socket.terminate.mockImplementation(() => {
      // Destroy can settle a pending write before close; retain the decision snapshot.
      callbacks.at(-1)?.(new Error("private teardown error"));
      socket.bufferedAmount = 0;
      socket.emit("close", 1006, Buffer.alloc(0));
    });
    const handler = await connectWs({ socket });

    registerClient(handler, socket, {
      connId: "conn-authenticated-user",
      authenticatedUserId: "alice@example.com",
    });

    if (write === "pending") {
      vi.advanceTimersByTime(25_000);
      socket.emit("pong");
      vi.advanceTimersByTime(25_000);
      callbacks[0]?.(); // An old completion must not mark the new attempt completed.
      vi.advanceTimersByTime(25_000);
    } else {
      vi.advanceTimersByTime(durationMs);
    }
    if (!cause) {
      socket.emit("close", code, Buffer.from("done"));
    }
    const closeReason = cause ? "n/a" : "done";
    const context = {
      cause,
      durationMs,
      ...(cause
        ? {
            pingWriteState: write === "threw" ? "failed" : write,
            lastPongAgeMs: write === "pending" ? 50_000 : undefined,
            bufferedBytes: 41,
          }
        : {}),
    };
    expect(logWsControl.info).toHaveBeenCalledWith(
      expect.stringContaining(`webchat disconnected code=${code} reason=${closeReason} conn=`),
      context,
    );
    expect(logWsControl.info).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^authenticated user disconnected code=${code} reason=${closeReason} conn=.+ user=alice@example\\.com$`,
        ),
      ),
      context,
    );
    expect(socket.terminate).toHaveBeenCalledTimes(cause ? 1 : 0);
    expect(JSON.stringify(logWsControl.info.mock.calls)).not.toContain("private");
  },
);

it.each([false, true])("records node disconnects unless stale=%s", async (stale) => {
  const unregister = vi.fn(() => (stale ? null : "node-1"));
  const get = vi.fn();
  const publishPresence = vi.fn();
  const handler = await connectWs({
    options: {
      refreshHealthSnapshot: vi.fn(),
      buildRequestContext: () =>
        makeContext({ nodeRegistry: { get, unregister } as never, publishPresence }) as never,
    },
  });
  if (!stale) {
    get.mockReturnValue({
      nodeId: "node-1",
      connId: handler.connId,
      connectedAtMs: 1_000,
      pairingGeneration: "generation-1",
    });
  }
  registerClient(handler, socket, {
    connId: stale ? "conn-old" : handler.connId,
    connect: { ...nodeConnect, device: device("node-1") },
    presenceKey: "node-1",
  });
  socket.emit("close", 1000, Buffer.from(stale ? "stale" : "done"));
  await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
  if (stale) {
    expect(recordDisconnect).not.toHaveBeenCalled();
    expect(upsertPresence).not.toHaveBeenCalled();
    expect(publishPresence).not.toHaveBeenCalled();
  } else {
    expect(get).toHaveBeenCalledWith("node-1");
    await vi.waitFor(() => expect(recordDisconnect).toHaveBeenCalledOnce());
    expect(recordDisconnect).toHaveBeenCalledWith({
      nodeId: "node-1",
      connectedAtMs: 1_000,
      disconnectedAtMs: expect.any(Number),
      expectedPairingGeneration: { nodeId: "node-1", key: "generation-1" },
    });
  }
});
