import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions,
  type RealtimeTranscriptionWebSocketTransport,
} from "./websocket-session.js";

let cleanup: (() => Promise<void>) | undefined;
const sessions = new Set<ReturnType<typeof createRealtimeTranscriptionWebSocketSession>>();
const timeoutMessage = "test realtime transcription connection timeout";
const closedMessage = "test realtime transcription connection closed before ready";
type ProviderEvent = { type?: string; text?: string; message?: string };
type SessionOptions = Partial<
  Omit<RealtimeTranscriptionWebSocketSessionOptions<ProviderEvent>, "providerId">
>;

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
  onText?: (payload: unknown, ws: WebSocket) => void;
}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  const connections: WebSocket[] = [];
  wss.on("headers", (_headers, request) => {
    params?.onUpgrade?.(request.headers);
  });
  wss.on("connection", (ws) => {
    connections.push(ws);
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
      params?.onText?.(JSON.parse(buffer.toString()), ws);
    });
  });
  await once(wss, "listening");
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}`, connections };
}

function createSession(options: SessionOptions & Required<Pick<SessionOptions, "url">>) {
  const session = createRealtimeTranscriptionWebSocketSession<ProviderEvent>({
    providerId: "test",
    callbacks: {},
    sendAudio: (audio, transport) => transport.sendBinary(audio),
    ...options,
  });
  sessions.add(session);
  return session;
}

async function setup(
  options: SessionOptions = {},
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

function handleProviderEvent(
  event: ProviderEvent,
  transport: RealtimeTranscriptionWebSocketTransport,
) {
  if (event.type === "session.created") {
    transport.markReady();
  } else if (!transport.isReady() && event.type === "error") {
    transport.failConnect(new Error(event.message));
  } else if (event.text) {
    transport.callbacks.onTranscript?.(event.text);
  }
}

function expectError(onError: ReturnType<typeof vi.fn>, message: string | RegExp) {
  expect(onError).toHaveBeenCalledTimes(1);
  const error = expectDefined<Error>(onError.mock.calls[0]?.[0], "expected error call");
  expect(error).toBeInstanceOf(Error);
  const expected = typeof message === "string" ? message : expect.stringMatching(message);
  expect(error.message).toEqual(expected);
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

it.each([false, true])(
  "flushes the retained audio tail unless closed (close=%s)",
  async (close) => {
    const { frames, ready, onFrame } = collectFrames<Buffer>(close ? 1 : 4);
    const { session } = await setup({ maxQueuedBytes: close ? 8 : 7 }, { onBinary: onFrame });

    const shiftSpy = vi.spyOn(Array.prototype, "shift");
    let shiftCalls = 0;
    try {
      for (let index = 0; index < 13_000; index += 1) {
        session.sendAudio(encodeSequence(index));
      }
      if (close) {
        session.close();
      } else {
        session.sendAudio(Buffer.from([0xaa, 0xbb, 0xcc]));
      }
      shiftCalls = shiftSpy.mock.calls.length;
    } finally {
      shiftSpy.mockRestore();
    }
    expect(shiftCalls).toBe(0);

    await session.connect();
    session.sendAudio(Buffer.from("live"));
    await ready;
    expect(frames).toEqual(
      close
        ? [Buffer.from("live")]
        : [
            encodeSequence(12_998),
            encodeSequence(12_999),
            Buffer.from([0xaa, 0xbb, 0xcc]),
            Buffer.from("live"),
          ],
    );
    expect(session.isConnected()).toBe(true);
  },
);

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
      onMessage: handleProviderEvent,
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
  expect(frames).toEqual([12_996, 12_997, 12_998, 12_999].map(encodeSequence));
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
    onMessage: handleProviderEvent,
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

  // Replay late callbacks from a retired connection against its replacement.
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
            : { type: "session.created" },
        ),
      );
    },
  });
  const { connections } = server;
  const session = createSession({
    callbacks: { onError },
    url: server.url,
    reconnectDelayMs: 1,
    onMessage: handleProviderEvent,
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
  const { session } = await setup(
    {
      callbacks: { onTranscript: (text) => transcripts.push(text) },
      closeTimeoutMs: 100,
      onClose: (transport) => transport.sendJson({ type: "finalize" }),
      onMessage: handleProviderEvent,
    },
    {
      onConnection: (socket) => socket.once("close", () => closed.resolve()),
      onText: (payload, socket) => {
        finalizedFrames.push(payload);
        if (finalizedFrames.length === 1) {
          socket.send(JSON.stringify({ text: "final provider transcript" }));
          socket.close(1000, "finished");
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

it.each(["binary", "JSON"] as const)("caps active %s frames and terminates once", async (kind) => {
  let providerTransport: RealtimeTranscriptionWebSocketTransport | undefined;
  const { session, onError } = await setup({
    onOpen: (transport) => {
      providerTransport = transport;
    },
  });

  await session.connect();
  const terminate = saturateSocket(session);

  if (kind === "binary") {
    session.sendAudio(Buffer.from([1]));
  } else {
    expect(providerTransport?.sendJson({ type: "provider.control" })).toBe(false);
  }
  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(session.isConnected()).toBe(false);
  expectError(onError, /send buffer exceeded/);
  if (kind === "binary") {
    session.sendAudio(Buffer.from([2]));
    expect(terminate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(1);
  }
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
  const { session } = await setup(
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

it.each([false, true])("resolves async URL/headers unless closed (close=%s)", async (close) => {
  const seenAuthHeaders: Array<string | string[] | undefined> = [];
  const url = createDeferred<string>();
  const server = await createRealtimeServer({
    onUpgrade: (headers) => seenAuthHeaders.push(headers.authorization),
  });
  const session = createSession({
    url: () => url.promise,
    headers: async () => ({ Authorization: "Bearer resolved-token" }),
    readyOnOpen: true,
  });
  const connecting = session.connect();
  if (close) {
    session.close();
  }
  url.resolve(server.url);
  await connecting;
  expect(seenAuthHeaders).toEqual(close ? [] : ["Bearer resolved-token"]);
  expect(session.isConnected()).toBe(!close);
});

it.each([
  ["queued audio", "queued audio send failed"],
  ["provider setup", "nope"],
  ["pre-ready close", closedMessage],
  ["connection resolution", "connection unavailable"],
  ["socket construction", "not a valid websocket URL"],
] as const)("reports %s failures through connect and the observer", async (phase, message) => {
  const options: SessionOptions = {
    readyOnOpen: false,
    onMessage: handleProviderEvent,
    connectTimeoutMessage: timeoutMessage,
    connectClosedBeforeReadyMessage: closedMessage,
  };
  if (phase === "connection resolution") {
    options.url = async () => {
      throw new Error(message);
    };
  } else if (phase === "socket construction") {
    options.url = message;
  } else if (phase === "queued audio") {
    options.sendAudio = () => {
      throw new Error(message);
    };
  }
  const { session, onError } = await setup(options, {
    closeOnConnection: phase === "pre-ready close",
    initialEvent:
      phase === "provider setup" ? { type: "error", message } : { type: "session.created" },
  });
  if (phase === "queued audio") {
    session.sendAudio(Buffer.from("queued"));
  }
  await expect(session.connect()).rejects.toThrow(message);
  expect(session.isConnected()).toBe(false);
  expectError(onError, phase === "socket construction" ? /not a valid websocket URL/ : message);
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
    connectTimeoutMessage: timeoutMessage,
    readyOnOpen: true,
  });

  try {
    const connecting = session.connect();
    const timeoutAssertion = expect(connecting).rejects.toThrow(timeoutMessage);
    await vi.advanceTimersByTimeAsync(10);

    await timeoutAssertion;
    expect(session.isConnected()).toBe(false);
    expectError(onError, timeoutMessage);
  } finally {
    vi.unstubAllEnvs();
  }
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

it("refreshes the reconnect budget after a stable ready connection", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { session, onError, connections } = await setup(
    {
      readyOnOpen: false,
      maxReconnectAttempts: 1,
      reconnectDelayMs: 5,
      onMessage: handleProviderEvent,
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
