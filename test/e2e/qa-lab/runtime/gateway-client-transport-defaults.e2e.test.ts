import { setImmediate as waitForImmediate } from "node:timers/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
} from "../../../../packages/gateway-client/src/index.js";
import { createDeferred } from "../../../helpers/promise.js";

type RequestFrame = { id: string; method: string };

const clients: GatewayClient[] = [];
let server: WebSocketServer | undefined;

const sendFrame = (socket: WebSocket, frame: unknown) => socket.send(JSON.stringify(frame));
const sendEvent = (socket: WebSocket, event: string, seq: number, payload: unknown) =>
  sendFrame(socket, { type: "event", event, seq, payload });

function waitForClose(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function flushSocketIo(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await waitForImmediate();
  }
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flushSocketIo(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function connectWithFakeTime(
  params: {
    clientOptions?: Omit<GatewayClientOptions, "onHelloOk" | "onClose" | "url">;
    onConnection?: (socket: WebSocket) => void;
    tickIntervalMs?: number;
  } = {},
) {
  const socketReady = createDeferred<WebSocket>();
  const requestReady = createDeferred<RequestFrame>();
  const helloReady = createDeferred();
  const closeEvents: Array<{ code: number; reason: string }> = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(rawDataToString(data)) as RequestFrame;
      if (request.method === "connect" && params.tickIntervalMs !== undefined) {
        sendFrame(socket, {
          type: "res",
          id: request.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            policy: { tickIntervalMs: params.tickIntervalMs },
          },
        });
      } else {
        requestReady.resolve(request);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server?.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway client defaults server did not get a TCP address");
  }
  server?.once("connection", (socket) => {
    // Establish the real transport before timers become deterministic.
    vi.useFakeTimers({
      toFake: ["Date", "clearInterval", "clearTimeout", "setInterval", "setTimeout"],
    });
    socketReady.resolve(socket);
  });
  server?.on("connection", (socket) => params.onConnection?.(socket));
  const client = new GatewayClient({
    ...params.clientOptions,
    url: `ws://127.0.0.1:${address.port}`,
    onClose: (code, reason) => closeEvents.push({ code, reason }),
    onHelloOk: () => helloReady.resolve(undefined),
    onConnectError:
      params.clientOptions?.onConnectError ??
      (params.tickIntervalMs === undefined ? undefined : (error) => helloReady.reject(error)),
  });
  clients.push(client);
  client.start();
  const socket = await socketReady.promise;
  await flushSocketIo();
  if (params.tickIntervalMs !== undefined) {
    sendEvent(socket, "connect.challenge", 1, { nonce: "defaults-1", ts: 1_777_777_777_000 });
    await helloReady.promise;
  }
  return { client, socket, requestReady: requestReady.promise, closeEvents };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (server) {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
});

describe("GatewayClient transport defaults", () => {
  it("uses a 30 second default request timeout", async () => {
    const { client, requestReady } = await connectWithFakeTime({ tickIntervalMs: 60_000 });

    let settled = false;
    const outcome = client
      .request("status")
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    expect((await requestReady).method).toBe("status");

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayClientRequestTimeoutError);
    expect(error).toMatchObject({
      message: "gateway request timeout for status",
      method: "status",
      requestSent: true,
      timeoutMs: 30_000,
    });
  });

  it("enforces the 30 second connect-challenge watchdog", async () => {
    const errors: Error[] = [];
    const { socket } = await connectWithFakeTime({
      clientOptions: { onConnectError: (error) => errors.push(error) },
    });
    const closed = waitForClose(socket);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(
      "gateway connect challenge timeout (waited 30000ms, limit 30000ms)",
    );
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "connect challenge timeout",
    });
  });

  it("jitters exponential reconnect delays within the 30 second cap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sockets: WebSocket[] = [];
    const { socket: initialSocket, closeEvents } = await connectWithFakeTime({
      onConnection: (socket) => {
        sockets.push(socket);
        if (sockets.length > 1) {
          void waitForImmediate().then(() => socket.close(1012, "retry"));
        }
      },
    });
    initialSocket.close(1012, "retry");

    // A midpoint draw observes jitter, including its shifted interval at the cap.
    const expectedDelays = [1_100, 2_200, 4_400, 8_800, 17_600, 27_500, 27_500];
    for (const [index, delayMs] of expectedDelays.entries()) {
      await waitForCondition(() => closeEvents.length >= index + 1, `close event ${index + 1}`);
      const connectionCount = sockets.length;

      await vi.advanceTimersByTimeAsync(delayMs - 1);
      await flushSocketIo();
      expect(sockets).toHaveLength(connectionCount);

      await vi.advanceTimersByTimeAsync(1);
      await waitForCondition(
        () => sockets.length === connectionCount + 1,
        `reconnect ${index + 1}`,
      );
    }

    expect(closeEvents).toEqual(expectedDelays.map(() => ({ code: 1012, reason: "retry" })));
  });

  it("uses the server tick interval and closes missing ticks with code 4000", async () => {
    const { socket, closeEvents } = await connectWithFakeTime({
      tickIntervalMs: 50,
      clientOptions: { tickWatchMinIntervalMs: 1 },
    });
    const serverClose = waitForClose(socket);

    await vi.advanceTimersByTimeAsync(100);
    expect(closeEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    await expect(serverClose).resolves.toEqual({ code: 4000, reason: "tick timeout" });
    await waitForCondition(() => closeEvents.length === 1, "client tick-timeout close callback");
    expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
  });

  it("keeps an unbounded request alive while inbound ticks continue", async () => {
    const { client, socket, requestReady, closeEvents } = await connectWithFakeTime({
      tickIntervalMs: 5_000,
      clientOptions: { tickWatchMinIntervalMs: 1 },
    });
    const request = client.request<{ status: string }>(
      "chat.send",
      { message: "defaults" },
      { timeoutMs: null },
    );
    const requestFrame = await requestReady;
    expect(requestFrame.method).toBe("chat.send");

    for (let sequence = 1; sequence <= 8; sequence += 1) {
      await vi.advanceTimersByTimeAsync(4_000);
      sendEvent(socket, "tick", sequence, { ts: Date.now() });
      await flushSocketIo();
    }

    expect(closeEvents).toEqual([]);
    sendFrame(socket, {
      type: "res",
      id: requestFrame.id,
      ok: true,
      payload: { status: "ok" },
    });
    await expect(request).resolves.toEqual({ status: "ok" });
  });
});
