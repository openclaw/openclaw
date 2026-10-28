import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions as WebSocketOptions,
  type RealtimeTranscriptionWebSocketTransport as Transport,
} from "./websocket-session.js";

let cleanup: (() => Promise<void>) | undefined;
const sessions = new Set<ReturnType<typeof createRealtimeTranscriptionWebSocketSession>>();
const timeoutMessage = "test realtime transcription connection timeout";
const closedMessage = "test realtime transcription connection closed before ready";
type ProviderEvent = { type?: string; text?: string; message?: string };
type SessionOptions = Partial<Omit<WebSocketOptions<ProviderEvent>, "providerId">>;

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of sessions) {
    session.close();
  }
  sessions.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

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
  onConnect?: (ws: WebSocket, number: number) => void,
) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  const connections: WebSocket[] = [];
  const frames: unknown[] = [];
  const authHeaders: Array<string | string[] | undefined> = [];
  const received = new EventEmitter();
  wss.on("headers", (_headers, request) => authHeaders.push(request.headers.authorization));
  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.on("message", (data, isBinary) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      frames.push(isBinary ? buffer : JSON.parse(buffer.toString()));
      received.emit("frame");
    });
    onConnect?.(ws, connections.length);
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
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const onError = vi.fn();
  const onTranscript = vi.fn();
  const transports: Transport[] = [];
  const session = createSession({
    url,
    readyOnOpen: true,
    callbacks: { onError, onTranscript },
    onOpen: (transport) => transports.push(transport),
    ...options,
  });
  return {
    url,
    session,
    onError,
    onTranscript,
    transports,
    connections,
    frames,
    authHeaders,
    waitFrames: async (count: number) => {
      while (frames.length < count) {
        await once(received, "frame");
      }
    },
    connection: async (count: number) => {
      await vi.waitFor(() => expect(connections).toHaveLength(count));
      return expectDefined(connections[count - 1], "expected server connection");
    },
  };
}

function handleProviderEvent(event: ProviderEvent, transport: Transport) {
  if (event.type === "session.created") {
    transport.markReady();
  } else if (!transport.isReady() && event.type === "error") {
    transport.failConnect(new Error(event.message));
  } else if (event.text) {
    transport.callbacks.onTranscript?.(event.text);
  }
}

function expectError(onError: ReturnType<typeof vi.fn>, message: string | RegExp) {
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  const error = expectDefined<Error>(onError.mock.calls[0]?.[0], "expected error call");
  const expected = typeof message === "string" ? message : expect.stringMatching(message);
  expect(error.message).toEqual(expected);
  return error;
}

function saturateSocket(session: ReturnType<typeof createSession>) {
  const socket = Reflect.get(session, "ws") as WebSocket;
  Object.defineProperty(socket, "bufferedAmount", { configurable: true, get: () => 1024 * 1024 });
  return vi.spyOn(socket, "terminate");
}

function encodeSequence(value: number): Buffer {
  const frame = Buffer.allocUnsafe(2);
  frame.writeUInt16BE(value);
  return frame;
}

it.each(["closed", "reconnect"] as const)("retains the audio tail: %s", async (phase) => {
  const reconnect = phase === "reconnect";
  const { session, frames, waitFrames, connection } = await setup({
    maxQueuedBytes: 7,
    readyOnOpen: !reconnect,
    maxReconnectAttempts: 1,
    reconnectDelayMs: 1,
    onMessage: handleProviderEvent,
  });
  let replacement: WebSocket | undefined;
  if (reconnect) {
    const connecting = session.connect();
    (await connection(1)).send(JSON.stringify({ type: "session.created" }));
    await connecting;
    (await connection(1)).close(1011, "reconnect");
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    replacement = await connection(2);
  }
  for (let index = 0; index < 13_000; index += 1) {
    session.sendAudio(encodeSequence(index));
  }
  session.sendAudio(Buffer.from([0xaa, 0xbb, 0xcc]));
  if (replacement) {
    replacement.send(JSON.stringify({ type: "session.created" }));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));
  } else {
    session.close();
    await session.connect();
  }
  session.sendAudio(Buffer.from("live"));
  const tail = [12_998, 12_999].map(encodeSequence);
  const expected = reconnect ? [...tail, Buffer.from([0xaa, 0xbb, 0xcc])] : [];
  expected.push(Buffer.from("live"));
  await waitFrames(expected.length);
  expect(frames).toEqual(expected);
  expect(session.isConnected()).toBe(true);
});

it("owns queued bytes without replaying successfully flushed frames", async () => {
  const sentFrames: string[] = [];
  let shouldFailSecondFrame = true;
  const { session, onError } = await setup({
    sendAudio: (audio, transport) => {
      if (audio.toString() === "second" && shouldFailSecondFrame) {
        shouldFailSecondFrame = false;
        throw new Error("second frame failed");
      }
      expect(audio.buffer.byteLength).toBe(audio.byteLength);
      sentFrames.push(audio.toString());
      transport.sendBinary(audio);
    },
  });
  session.sendAudio(Buffer.from("first"));
  const second = Buffer.from("second");
  session.sendAudio(second);
  second.fill(0);
  await expect(session.connect()).rejects.toThrow("second frame failed");
  expect(session.isConnected()).toBe(false);
  expectError(onError, "second frame failed");
  await session.connect();
  expect(sentFrames).toEqual(["first", "second"]);
});

it("keeps replacement sockets owned when retired socket callbacks arrive late", async () => {
  const { session, connections, transports, onError, onTranscript } = await setup({
    closeTimeoutMs: 30,
    reconnectDelayMs: 1,
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

it.each(["natural", "timeout"] as const)("finishes graceful shutdown: %s", async (mode) => {
  const closed = createDeferred();
  const { session, frames, onTranscript } = await setup(
    {
      closeTimeoutMs: mode === "natural" ? 100 : 20,
      onClose: (transport) => transport.sendJson({ type: "finalize" }),
      onMessage: handleProviderEvent,
    },
    (socket) => {
      socket.once("close", () => closed.resolve());
      socket.on("message", () => {
        if (mode === "natural") {
          socket.send(JSON.stringify({ text: "final transcript" }));
          socket.close(1000, "finished");
        }
      });
    },
  );
  await session.connect();
  const terminate = vi.spyOn(Reflect.get(session, "ws") as WebSocket, "terminate");
  session.close();
  session.close();
  if (mode === "natural") {
    await closed.promise;
    await vi.waitFor(() =>
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("final transcript"),
    );
    expect(frames).toEqual([{ type: "finalize" }]);
  } else {
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce(), { timeout: 500 });
    expect(session.isConnected()).toBe(false);
  }
});

it.each(["binary", "JSON"] as const)("caps active %s frames and terminates once", async (kind) => {
  const { session, onError, transports } = await setup();
  await session.connect();
  const terminate = saturateSocket(session);
  if (kind === "binary") {
    session.sendAudio(Buffer.from([1]));
  } else {
    expect(transports[0]?.sendJson({ type: "provider.control" })).toBe(false);
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
  const { session, frames, waitFrames } = await setup(
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
    (socket) => socket.send(JSON.stringify({ type: "session.created" })),
  );
  session.sendAudio(Buffer.from("queued"));
  await session.connect();
  await waitFrames(2);
  expect(frames).toEqual([
    { type: "session.update" },
    { type: "input_audio.append", audio: Buffer.from("queued").toString("base64") },
  ]);
});

it.each(["connected", "closed", "superseded"] as const)(
  "resolves async credentials: %s",
  async (phase) => {
    const url = createDeferred<string>();
    let attempts = 0;
    const state: Awaited<ReturnType<typeof setup>> = await setup({
      url: () => (++attempts === 1 ? url.promise : state.url),
      headers: async () => ({ Authorization: "Bearer resolved-token" }),
    });
    const { session, connections } = state;
    const connecting = session.connect();
    if (phase !== "connected") {
      session.close();
    }
    if (phase === "superseded") {
      await session.connect();
    }
    url.resolve(state.url);
    await connecting;
    if (phase === "superseded") {
      await delay(20);
      expect(connections).toHaveLength(1);
    }
    expect(state.authHeaders).toEqual(phase === "closed" ? [] : ["Bearer resolved-token"]);
    expect(session.isConnected()).toBe(phase !== "closed");
  },
);

it.each([
  ["provider setup", "nope"],
  ["pre-ready close", closedMessage],
  ["connection resolution", "connection unavailable"],
  ["socket construction", "not a valid websocket URL"],
] as const)("reports %s failures through connect and the observer", async (phase, message) => {
  const options: SessionOptions = {
    readyOnOpen: false,
    onMessage: handleProviderEvent,
    connectClosedBeforeReadyMessage: closedMessage,
  };
  if (phase === "connection resolution") {
    options.url = async () => {
      throw new Error(message);
    };
  } else if (phase === "socket construction") {
    options.url = message;
  }
  const { session, onError } = await setup(options, (socket) => {
    if (phase === "pre-ready close") {
      socket.close(1011, "setup failed");
    } else {
      const event =
        phase === "provider setup" ? { type: "error", message } : { type: "session.created" };
      socket.send(JSON.stringify(event));
    }
  });
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
  const connecting = session.connect();
  const timeoutAssertion = expect(connecting).rejects.toThrow(timeoutMessage);
  await vi.advanceTimersByTimeAsync(10);
  await timeoutAssertion;
  expect(session.isConnected()).toBe(false);
  expectError(onError, timeoutMessage);
});

it.each(["failed handshake", "stable reset"] as const)("reconnect lifecycle: %s", async (mode) => {
  const stable = mode === "stable reset";
  let now = 0;
  if (stable) {
    vi.spyOn(Date, "now").mockImplementation(() => now);
  }
  const { session, connections, onError } = await setup(
    {
      readyOnOpen: false,
      maxReconnectAttempts: stable ? 1 : 5,
      reconnectDelayMs: stable ? 5 : 1,
      onMessage: handleProviderEvent,
    },
    (socket, number) => {
      const event =
        !stable && number === 2
          ? { type: "error", message: "provider handshake rejected" }
          : { type: "session.created" };
      socket.send(JSON.stringify(event));
    },
  );
  await session.connect();
  const droppedSockets = stable ? [0, 1] : [0, 2];
  for (const [step, index] of droppedSockets.entries()) {
    const count = step + (stable ? 2 : 3);
    connections[index]?.close(1011, "disconnect");
    await vi.waitFor(
      () => expect(connections).toHaveLength(count),
      !stable && count === 4 ? { timeout: 500 } : undefined,
    );
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));
    if (stable) {
      now = 30_000;
    }
  }
  if (stable) {
    connections[2]?.close(1011, "second flap");
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "test realtime transcription reconnect limit reached" }),
      ),
    );
    expect(connections).toHaveLength(3);
  } else {
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider handshake rejected" }),
    );
  }
});

it.each(["malformed", "oversized"] as const)("rejects %s frames before dispatch", async (kind) => {
  const onMessage = vi.fn(() => {
    throw new Error("invalid frame reached provider handler");
  });
  const onError = vi.fn((_error: Error) => {
    throw new Error("error observer failed");
  });
  const { session } = await setup({ callbacks: { onError }, onMessage }, (socket) =>
    socket.send(kind === "malformed" ? "{not json" : "x".repeat(16 * 1024 * 1024 + 1)),
  );
  await session.connect();
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(onMessage).not.toHaveBeenCalled();
  const error = expectError(
    onError,
    kind === "malformed"
      ? "Realtime transcription websocket received malformed JSON."
      : /max payload/i,
  );
  if (kind === "oversized") {
    expect(error).toHaveProperty("code", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  } else {
    expect(session.isConnected()).toBe(true);
  }
});
