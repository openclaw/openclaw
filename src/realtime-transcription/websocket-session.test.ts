import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions,
  type RealtimeTranscriptionWebSocketTransport,
} from "./websocket-session.js";

let cleanup: (() => Promise<void>) | undefined;
const sessions = new Set<ReturnType<typeof createRealtimeTranscriptionWebSocketSession>>();

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  for (const session of sessions) {
    session.close();
  }
  sessions.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

async function createRealtimeServer(params?: {
  closeOnConnection?: boolean;
  initialEvent?: unknown;
  initialText?: string;
  onConnection?: (ws: WebSocket) => void;
  onUpgrade?: (headers: Record<string, string | string[] | undefined>) => void;
  onBinary?: (payload: Buffer) => void;
  onText?: (payload: unknown) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const connections: WebSocket[] = [];

  server.on("upgrade", (request, socket, head) => {
    params?.onUpgrade?.(request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      connections.push(ws);
      ws.on("close", () => clients.delete(ws));
      if (params?.closeOnConnection) {
        ws.close(1011, "setup failed");
        return;
      }
      if (params?.initialEvent) {
        ws.send(JSON.stringify(params.initialEvent));
      }
      if (params?.initialText) {
        ws.send(params.initialText);
      }
      params?.onConnection?.(ws);
      ws.on("message", (data, isBinary) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (isBinary) {
          params?.onBinary?.(buffer);
          return;
        }
        params?.onText?.(JSON.parse(buffer.toString()));
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  const port = (server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}`, connections };
}

function createSession<Event = unknown>(
  options: Omit<
    RealtimeTranscriptionWebSocketSessionOptions<Event>,
    "providerId" | "callbacks" | "sendAudio"
  > &
    Partial<Pick<RealtimeTranscriptionWebSocketSessionOptions<Event>, "callbacks" | "sendAudio">>,
) {
  const session = createRealtimeTranscriptionWebSocketSession<Event>({
    providerId: "test",
    callbacks: {},
    sendAudio: (audio, transport) => transport.sendBinary(audio),
    ...options,
  });
  sessions.add(session);
  return session;
}

function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
  return expectDefined(mock.mock.calls[0]?.[0], `expected ${label} call`);
}

async function setup<Event = unknown>(
  options: Partial<Omit<RealtimeTranscriptionWebSocketSessionOptions<Event>, "providerId">> = {},
  serverOptions?: Parameters<typeof createRealtimeServer>[0],
) {
  const server = await createRealtimeServer(serverOptions);
  const onError = vi.fn();
  const session = createSession({
    url: server.url,
    readyOnOpen: true,
    callbacks: { onError },
    ...options,
  });
  return { ...server, session, onError };
}

function collectFrames<T>(count: number) {
  const frames: T[] = [];
  const ready = createDeferred();
  return {
    frames,
    ready: ready.promise,
    onFrame: (frame: T) => {
      frames.push(frame);
      if (frames.length === count) {
        ready.resolve();
      }
    },
  };
}

function markSessionCreated(
  event: { type?: string },
  transport: RealtimeTranscriptionWebSocketTransport,
) {
  if (event.type === "session.created") {
    transport.markReady();
  }
}

function forwardTranscript(
  event: { text?: string },
  transport: RealtimeTranscriptionWebSocketTransport,
) {
  if (event.text) {
    transport.callbacks.onTranscript?.(event.text);
  }
}

function expectError(onError: ReturnType<typeof vi.fn>, message: string | RegExp) {
  expect(onError).toHaveBeenCalledTimes(1);
  const error = requireFirstMockArg<Error>(onError, "error");
  expect(error).toBeInstanceOf(Error);
  if (typeof message === "string") {
    expect(error.message).toBe(message);
  } else {
    expect(error.message).toMatch(message);
  }
  return error;
}

function saturateSocket(session: ReturnType<typeof createSession>) {
  const socket = Reflect.get(session, "ws") as WebSocket;
  Object.defineProperty(socket, "bufferedAmount", {
    configurable: true,
    get: () => 1024 * 1024,
  });
  return vi.spyOn(socket, "terminate");
}

function encodeSequence(value: number): Buffer {
  const frame = Buffer.allocUnsafe(2);
  frame.writeUInt16BE(value);
  return frame;
}

describe("createRealtimeTranscriptionWebSocketSession", () => {
  it("drops the oldest queued audio by bytes and flushes the retained tail in order", async () => {
    const { frames, ready, onFrame } = collectFrames<Buffer>(4);
    const { session } = await setup({ maxQueuedBytes: 7 }, { onBinary: onFrame });

    const shiftSpy = vi.spyOn(Array.prototype, "shift");
    let shiftCalls = 0;
    try {
      for (let index = 0; index < 13_000; index += 1) {
        session.sendAudio(encodeSequence(index));
      }
      session.sendAudio(Buffer.from([0xaa, 0xbb, 0xcc]));
      shiftCalls = shiftSpy.mock.calls.length;
    } finally {
      shiftSpy.mockRestore();
    }
    expect(shiftCalls).toBe(0);

    await session.connect();
    session.sendAudio(Buffer.from("live"));
    await ready;
    expect(frames).toEqual([
      encodeSequence(12_998),
      encodeSequence(12_999),
      Buffer.from([0xaa, 0xbb, 0xcc]),
      Buffer.from("live"),
    ]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("rejects startup when queued audio fails during the provider readiness handshake", async () => {
    const { session, onError } = await setup(
      {
        readyOnOpen: false,
        onMessage: markSessionCreated,
        sendAudio: () => {
          throw new Error("queued audio send failed");
        },
      },
      { initialEvent: { type: "session.created" } },
    );

    session.sendAudio(Buffer.from("queued"));
    await expect(session.connect()).rejects.toThrow("queued audio send failed");
    expect(session.isConnected()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    session.close();
  });

  it("does not replay successfully flushed audio after a later frame fails", async () => {
    const sentFrames: string[] = [];
    let shouldFailSecondFrame = true;
    const { session, onError } = await setup({
      sendAudio: (audio, transport) => {
        if (audio.toString() === "second" && shouldFailSecondFrame) {
          shouldFailSecondFrame = false;
          throw new Error("second frame failed");
        }
        sentFrames.push(audio.toString());
        transport.sendBinary(audio);
      },
    });

    session.sendAudio(Buffer.from("first"));
    session.sendAudio(Buffer.from("second"));
    await expect(session.connect()).rejects.toThrow("second frame failed");
    expect(session.isConnected()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    await session.connect();

    expect(sentFrames).toEqual(["first", "second"]);
  });

  it("flushes a large retained audio tail in order after reconnect", async () => {
    const { frames, ready, onFrame } = collectFrames<Buffer>(4);
    const { session, connections } = await setup(
      {
        readyOnOpen: false,
        maxQueuedBytes: 8,
        maxReconnectAttempts: 1,
        reconnectDelayMs: 1,
        onMessage: markSessionCreated,
      },
      { onBinary: onFrame },
    );

    const connecting = session.connect();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]?.send(JSON.stringify({ type: "session.created" }));
    await connecting;

    connections[0]?.close(1011, "reconnect");
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    for (let index = 0; index < 13_000; index += 1) {
      session.sendAudio(encodeSequence(index));
    }
    connections[1]?.send(JSON.stringify({ type: "session.created" }));

    await ready;
    expect(frames).toEqual([
      encodeSequence(12_996),
      encodeSequence(12_997),
      encodeSequence(12_998),
      encodeSequence(12_999),
    ]);
  });

  it("discards a large queued audio tail when closed before connecting", async () => {
    const { frames, ready, onFrame } = collectFrames<Buffer>(1);
    const { session } = await setup({ maxQueuedBytes: 8 }, { onBinary: onFrame });

    for (let index = 0; index < 13_000; index += 1) {
      session.sendAudio(encodeSequence(index));
    }
    session.close();

    await session.connect();
    session.sendAudio(Buffer.from("live"));
    await ready;
    expect(frames).toEqual([Buffer.from("live")]);
  });

  it("keeps replacement sockets owned when retired socket callbacks arrive late", async () => {
    const transports: RealtimeTranscriptionWebSocketTransport[] = [];
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { session, connections } = await setup({
      callbacks: { onError, onTranscript },
      closeTimeoutMs: 30,
      reconnectDelayMs: 1,
      onOpen: (transport) => transports.push(transport),
      onMessage: forwardTranscript,
    });

    await session.connect();
    const retiredSocket = Reflect.get(session, "ws") as WebSocket;
    session.close();
    await session.connect();
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    const retiredTransport = expectDefined(transports[0], "retired socket transport");
    expect(retiredTransport.isOpen()).toBe(false);
    expect(retiredTransport.isReady()).toBe(false);
    expect(retiredTransport.sendJson({ type: "retired" })).toBe(false);
    retiredTransport.markReady();
    retiredTransport.failConnect(new Error("retired provider failed"));
    retiredTransport.closeNow();

    // ws delivers close/error/message asynchronously; replaying those actual
    // socket callbacks proves a retired connection cannot poison its replacement.
    retiredSocket.emit("message", Buffer.from(JSON.stringify({ text: "stale transcript" })));
    retiredSocket.emit("error", new Error("retired socket failed"));
    retiredSocket.emit("close", 1000, Buffer.from("retired"));

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);

    await delay(60);
    expect(session.isConnected()).toBe(true);
    expect(connections).toHaveLength(2);

    connections[1]?.send(JSON.stringify({ text: "current transcript" }));
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("current transcript"));
  });

  it("discards superseded asynchronous connection preparation", async () => {
    const server = await createRealtimeServer();
    const { connections } = server;
    const firstUrl = createDeferred<string>();
    let connectionAttempt = 0;
    const session = createSession({
      url: async () => (++connectionAttempt === 1 ? await firstUrl.promise : server.url),
      readyOnOpen: true,
    });

    const supersededConnection = session.connect();
    session.close();
    await session.connect();
    firstUrl.resolve(server.url);
    await supersededConnection;

    await delay(20);
    expect(connections).toHaveLength(1);
    expect(session.isConnected()).toBe(true);
  });

  it("cancels a retired reconnect delay before starting a replacement socket", async () => {
    const { session, connections } = await setup({ reconnectDelayMs: 50 });

    await session.connect();
    connections[0]?.close(1011, "retired connection");
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));

    session.close();
    await session.connect();
    await delay(100);

    expect(connections).toHaveLength(2);
    expect(session.isConnected()).toBe(true);
  });

  it("reconnects after a healthy successor closes following a failed connection", async () => {
    const onError = vi.fn();
    const server = await createRealtimeServer({
      onConnection: (socket) => {
        socket.send(
          JSON.stringify(
            connections.length === 2
              ? { type: "error", message: "provider handshake rejected" }
              : { type: "ready" },
          ),
        );
      },
    });
    const { connections } = server;
    const session = createSession<{ message?: string; type?: string }>({
      callbacks: { onError },
      url: server.url,
      reconnectDelayMs: 1,
      onMessage: (event, transport) => {
        if (event.type === "ready") {
          transport.markReady();
        } else if (event.type === "error") {
          transport.failConnect(new Error(event.message));
        }
      },
    });

    await session.connect();
    connections[0]?.close(1011, "first connection dropped");
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider handshake rejected" }),
    );

    connections[2]?.close(1011, "healthy connection dropped");
    await vi.waitFor(() => expect(connections).toHaveLength(4), { timeout: 500 });
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));
  });

  it("delivers graceful provider finals before natural close and finalizes only once", async () => {
    const finalizedFrames: unknown[] = [];
    const transcripts: string[] = [];
    const closed = createDeferred();
    let providerSocket: WebSocket | undefined;
    const { session } = await setup(
      {
        callbacks: { onTranscript: (text) => transcripts.push(text) },
        closeTimeoutMs: 100,
        onClose: (transport) => {
          transport.sendJson({ type: "finalize" });
        },
        onMessage: forwardTranscript,
      },
      {
        onConnection: (socket) => {
          providerSocket = socket;
          socket.once("close", () => closed.resolve());
        },
        onText: (payload) => {
          finalizedFrames.push(payload);
          if (finalizedFrames.length === 1) {
            providerSocket?.send(JSON.stringify({ text: "final provider transcript" }));
            providerSocket?.close(1000, "finished");
          }
        },
      },
    );

    await session.connect();
    session.close();
    session.close();

    await closed.promise;
    await vi.waitFor(() => expect(transcripts).toEqual(["final provider transcript"]));
    expect(finalizedFrames).toEqual([{ type: "finalize" }]);
  });

  it("terminates the captured socket when graceful provider shutdown expires", async () => {
    const { session } = await setup({ closeTimeoutMs: 20 });

    await session.connect();
    const ownedSocket = Reflect.get(session, "ws") as WebSocket;
    const terminate = vi.spyOn(ownedSocket, "terminate");
    session.close();

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce(), { timeout: 500 });
    expect(session.isConnected()).toBe(false);
  });

  it("terminates once when binary audio reaches the active socket buffer cap", async () => {
    const { session, onError } = await setup();

    await session.connect();
    const terminate = saturateSocket(session);

    session.sendAudio(Buffer.from([1]));
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(session.isConnected()).toBe(false);
    expectError(onError, /send buffer exceeded/);

    session.sendAudio(Buffer.from([2]));
    expect(terminate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("applies the active socket buffer cap to JSON provider frames", async () => {
    let providerTransport: RealtimeTranscriptionWebSocketTransport | undefined;
    const { session, onError } = await setup({
      onOpen: (transport) => {
        providerTransport = transport;
      },
    });

    await session.connect();
    const terminate = saturateSocket(session);

    expect(providerTransport?.sendJson({ type: "provider.control" })).toBe(false);
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(session.isConnected()).toBe(false);
    expectError(onError, /send buffer exceeded/);
  });

  it("rejects connect when provider handshake frames exceed the socket buffer cap", async () => {
    const { session, onError } = await setup({
      readyOnOpen: false,
      onOpen: (transport) => {
        saturateSocket(session);
        expect(transport.sendJson({ type: "session.update" })).toBe(false);
      },
    });

    await expect(session.connect()).rejects.toThrow(/send buffer exceeded/);
    expect(session.isConnected()).toBe(false);
    expectError(onError, /send buffer exceeded/);
  });

  it("lets providers mark ready after a JSON handshake", async () => {
    const { frames, ready, onFrame } = collectFrames<unknown>(2);
    const { session } = await setup<{ type?: string }>(
      {
        readyOnOpen: false,
        onMessage: (event, transport) => {
          if (event.type === "session.created") {
            transport.sendJson({ type: "session.update" });
            transport.markReady();
          }
        },
        sendAudio: (audio, transport) => {
          transport.sendJson({ type: "input_audio.append", audio: audio.toString("base64") });
        },
      },
      { initialEvent: { type: "session.created" }, onText: onFrame },
    );

    session.sendAudio(Buffer.from("queued"));
    await session.connect();
    await ready;
    expect(frames).toEqual([
      { type: "session.update" },
      { type: "input_audio.append", audio: Buffer.from("queued").toString("base64") },
    ]);
  });

  it("resolves async URLs and headers before opening the socket", async () => {
    const seenAuthHeaders: Array<string | string[] | undefined> = [];
    const server = await createRealtimeServer({
      onUpgrade: (headers) => {
        seenAuthHeaders.push(headers.authorization);
      },
    });
    const session = createSession({
      url: async () => server.url,
      headers: async () => ({ Authorization: "Bearer resolved-token" }),
      readyOnOpen: true,
    });

    await session.connect();

    expect(seenAuthHeaders).toEqual(["Bearer resolved-token"]);
  });

  it.each([
    {
      phase: "connection resolution",
      url: async () => {
        throw new Error("connection unavailable");
      },
      message: "connection unavailable",
    },
    {
      phase: "socket construction",
      url: "not a valid websocket URL",
      message: "not a valid websocket URL",
    },
  ])("reports $phase failures through connect and the observer", async ({ url, message }) => {
    const onError = vi.fn();
    const session = createSession({ url, callbacks: { onError } });

    await expect(session.connect()).rejects.toThrow(message);

    expect(session.isConnected()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(requireFirstMockArg(onError, "connection error")).toMatchObject({
      message: expect.stringContaining(message),
    });
  });

  it("preserves connect failures when the error callback throws", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    const onError = vi.fn((_error: Error) => {
      throw new Error("error observer failed");
    });
    const session = createSession({
      callbacks: { onError },
      url: () => new Promise<string>(() => {}),
      connectTimeoutMs: 10,
      connectTimeoutMessage: "test realtime transcription connection timeout",
      readyOnOpen: true,
    });

    try {
      const connecting = session.connect();
      const timeoutAssertion = expect(connecting).rejects.toThrow(
        "test realtime transcription connection timeout",
      );
      await vi.advanceTimersByTimeAsync(10);

      await timeoutAssertion;
      expect(session.isConnected()).toBe(false);
      expectError(onError, "test realtime transcription connection timeout");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not open a socket when closed while async connection resolves", async () => {
    const seenAuthHeaders: Array<string | string[] | undefined> = [];
    const url = createDeferred<string>();
    const server = await createRealtimeServer({
      onUpgrade: (headers) => {
        seenAuthHeaders.push(headers.authorization);
      },
    });
    const session = createSession({
      url: () => url.promise,
      headers: async () => ({ Authorization: "Bearer resolved-token" }),
      readyOnOpen: true,
    });

    const connecting = session.connect();
    session.close();
    url.resolve(server.url);
    await connecting;

    expect(seenAuthHeaders).toEqual([]);
    expect(session.isConnected()).toBe(false);
  });

  it("rejects provider setup errors before ready", async () => {
    const { session, onError } = await setup<{ type?: string; message?: string }>(
      {
        readyOnOpen: false,
        onMessage: (event, transport) => {
          if (!transport.isReady() && event.type === "error") {
            transport.failConnect(new Error(event.message));
          }
        },
      },
      { initialEvent: { type: "error", message: "nope" } },
    );

    await expect(session.connect()).rejects.toThrow("nope");
    expect(session.isConnected()).toBe(false);
    expectError(onError, "nope");
  });

  it("keeps error callback failures inside websocket message dispatch", async () => {
    const received = createDeferred();
    const onError = vi.fn((_error: Error) => {
      received.resolve();
      throw new Error("error observer failed");
    });
    const { session } = await setup(
      {
        callbacks: { onError },
        onMessage: () => {
          throw new Error("malformed payload should not reach provider handler");
        },
      },
      { initialText: "{not json" },
    );

    await session.connect();
    await received.promise;
    expectError(onError, "Realtime transcription websocket received malformed JSON.");
    expect(session.isConnected()).toBe(true);
  });

  it("reports pre-ready closes separately from connection timeouts", async () => {
    const { session, onError } = await setup(
      {
        readyOnOpen: false,
        connectTimeoutMessage: "test realtime transcription connection timeout",
        connectClosedBeforeReadyMessage:
          "test realtime transcription connection closed before ready",
      },
      { closeOnConnection: true },
    );

    await expect(session.connect()).rejects.toThrow(
      "test realtime transcription connection closed before ready",
    );
    expectError(onError, "test realtime transcription connection closed before ready");
  });

  it("refreshes the reconnect budget after a stable ready connection", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { session, onError, connections } = await setup(
      {
        readyOnOpen: false,
        maxReconnectAttempts: 1,
        reconnectDelayMs: 5,
        onMessage: markSessionCreated,
      },
      { initialEvent: { type: "session.created" } },
    );

    await session.connect();
    connections[0]?.close(1011, "first flap");
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));

    now = 30_000;
    connections[1]?.close(1011, "stable disconnect");
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));

    connections[2]?.close(1011, "second flap");
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "test realtime transcription reconnect limit reached",
        }),
      );
    });
    expect(connections).toHaveLength(3);
  });

  it("drops an oversized inbound message before it reaches the provider parser", async () => {
    // ws rejects a message above maxPayload with an error + 1009 close, so an
    // oversized upstream message never reaches onMessage/JSON parse.
    const oversized = "x".repeat(16 * 1024 * 1024 + 1);
    const received = createDeferred();
    const onError = vi.fn((_error: Error) => received.resolve());
    const onMessage = vi.fn(() => {
      throw new Error("oversized frame should not reach provider handler");
    });
    const { session } = await setup(
      { callbacks: { onError }, onMessage },
      { initialText: oversized },
    );

    await session.connect();
    await received.promise;
    expect(onMessage).not.toHaveBeenCalled();
    const overflowError = expectError(onError, /max payload/i);
    expect(overflowError).toHaveProperty("code", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  });
});
