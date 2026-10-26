import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { constants, deflateRawSync } from "node:zlib";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { sendNodeWebSocketEvent } from "../node-event-send.js";
import {
  SerializedGatewayFrame,
  SerializedJsonArray,
  SerializedJsonPayload,
  serializeGatewayFrame,
} from "../serialized-json.js";
import { GATEWAY_PER_MESSAGE_DEFLATE, installGatewayDeflateCodec } from "./ws-compression.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { attachGatewayWsForTest, type GatewayWsTestSocket } from "./ws-connection.test-helpers.js";
import type { GatewayWsMessageHandlerParams } from "./ws-connection/message-handler-types.js";
import { createGatewayWebSocketTransport } from "./ws-transport.js";

const attachHandler = vi.hoisted(() => vi.fn<(params: GatewayWsMessageHandlerParams) => void>());
const { Z_SYNC_FLUSH: finishFlush } = constants;
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachHandler,
}));

let server: Ws.WebSocketServer;
const connections = new Set<Ws.WebSocket>();
beforeEach(async () => {
  server = new Ws.WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
  });
  await once(server, "listening");
});
async function connect(perMessageDeflate: ClientOptions["perMessageDeflate"] = false) {
  const accepted = once(server, "connection");
  const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    perMessageDeflate,
  });
  connections.add(peer);
  const opened = once(peer, "open");
  const [socket, request] = (await accepted) as [Ws.WebSocket, import("node:http").IncomingMessage];
  connections.add(socket);
  await opened;
  return { peer, socket, request };
}
async function connectTransport(perMessageDeflate: ClientOptions["perMessageDeflate"] = false) {
  const { peer, socket, request } = await connect(perMessageDeflate);
  const codec = installGatewayDeflateCodec(socket)!;
  const transport = createGatewayWebSocketTransport(socket, request.socket, codec);
  return { peer, socket, request, codec, transport };
}
function send(
  transport: ReturnType<typeof createGatewayWebSocketTransport>,
  frame: Buffer | SerializedGatewayFrame,
) {
  return new Promise<void>((resolve, reject) => {
    transport.send(frame, { binary: false }, (error) => (error ? reject(error) : resolve()));
  });
}
afterEach(async () => {
  for (const socket of connections) {
    socket.terminate();
  }
  connections.clear();
  await promisify(server.close.bind(server))();
});

it.each([false, {}, { serverMaxWindowBits: 10 }] as const)(
  "counts raw frame sizes and actual payload bytes for node and direct events with compression %j",
  async (perMessageDeflate) => {
    const observations: DiagnosticEventPayload[] = [];
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
      include: ["gateway.ws.event"],
    });
    const { peer, socket, request, transport } = await connectTransport(perMessageDeflate);
    try {
      const threshold = GATEWAY_PER_MESSAGE_DEFLATE.threshold;
      const envelope = { type: "event", event: "chat", payload: "" };
      const envelopeLength = JSON.stringify(envelope).length;
      const frames = [threshold + 2, threshold - 1, threshold + 1].map((bytes) =>
        Buffer.from(JSON.stringify({ ...envelope, payload: "x".repeat(bytes - envelopeLength) })),
      );
      const before = request.socket.bytesWritten;
      // Raw and compressed frames share the same FIFO with control frames.
      const received: string[] = [];
      peer.on("message", (data, binary) => {
        expect(binary).toBe(false);
        received.push(rawDataToString(data));
      });
      const ping = once(peer, "ping");
      transport.batchWrites?.();
      expect(sendNodeWebSocketEvent(transport, "chat", () => frames[0]!.toString())).toBe(true);
      const sent = Promise.all(
        frames.slice(1).map(
          (frame) =>
            new Promise<void>((resolve, reject) => {
              const wireBytes = transport.send(frame, { binary: false }, (error) =>
                error ? reject(error) : resolve(),
              );
              transport.recordEventSent?.("chat", frame, undefined, undefined, wireBytes);
            }),
        ),
      );
      socket.ping("after-data");
      const closed = once(peer, "close");
      socket.close();
      await sent;
      expect((await ping)[0].toString()).toBe("after-data");
      await closed;
      expect(received).toEqual(frames.map((frame) => frame.toString()));
      await yieldImmediate();
      await waitForDiagnosticEventsDrained();
      const events = observations.filter((event) => event.type === "gateway.ws.event");
      const sum = (value: (event: (typeof events)[number]) => number) =>
        events.reduce((total, event) => total + value(event), 0);
      const rawBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
      const wireBytes = sum((event) => event.wireBytes ?? 0);
      const headers = (perMessageDeflate === false ? 12 : 8) + 2 + 12; // Close and ping frames.
      expect(wireBytes).toBe(request.socket.bytesWritten - before - headers);
      expect(sum((event) => event.count)).toBe(3);
      expect(sum((event) => event.bytes)).toBe(rawBytes);
      expect(sum((event) => event.frameBytes?.["+Inf"] ?? 0)).toBe(3);
      expect(sum((event) => event.frameBytes?.[String(threshold)] ?? 0)).toBe(1);
      if (perMessageDeflate === false) {
        expect(wireBytes).toBe(rawBytes);
      } else {
        expect(wireBytes).toBeLessThan(rawBytes / 2);
      }
    } finally {
      unsubscribe();
      setDiagnosticsEnabledForProcess(false);
    }
  },
);

it("matches ws wire bytes with one native submission at every uncompressed frame length boundary", async () => {
  const { peer, socket, request, transport } = await connectTransport();
  const writes = vi.spyOn(request.socket, "write");
  const nativeWrite = vi.spyOn(request.socket, "_write");
  // oxlint-disable-next-line no-underscore-dangle -- Count actual Writable submissions on Node and Bun.
  const nativeWritev = request.socket._writev ? vi.spyOn(request.socket, "_writev") : undefined;
  for (const length of [125, 126, 65535, 65536]) {
    const bytes = Buffer.from(JSON.stringify("x".repeat(length - 2)));
    const ordinary = once(peer, "message");
    writes.mockClear();
    socket.send(bytes, { binary: false });
    await ordinary;
    const expected = Buffer.concat(writes.mock.calls.map(([chunk]) => Buffer.from(chunk)));
    writes.mockClear();
    nativeWrite.mockClear();
    nativeWritev?.mockClear();
    const frame = new SerializedGatewayFrame([bytes.subarray(0, 1), bytes.subarray(1)]);
    const materialize = vi.spyOn(frame, "toBuffer");
    const received = once(peer, "message");
    const sent = send(transport, frame);
    const [[data, binary]] = await Promise.all([received, sent]);
    expect(binary).toBe(false);
    expect(data).toEqual(bytes);
    expect(materialize).not.toHaveBeenCalled();
    expect(nativeWrite.mock.calls.length + (nativeWritev?.mock.calls.length ?? 0)).toBe(1);
    // The no-writev adapter calls its captured native write once with the joined frame.
    const actual = nativeWrite.mock.calls.length
      ? Buffer.concat(nativeWrite.mock.calls.map(([chunk]) => Buffer.from(chunk)))
      : Buffer.concat(
          nativeWritev!.mock.calls.flatMap(([chunks]) =>
            chunks.map(({ chunk }) => Buffer.from(chunk)),
          ),
        );
    expect(actual).toEqual(expected);
  }
  writes.mockRestore();
});

it("delivers an owned shared history payload as a JSON text frame", async () => {
  const { peer, socket, request } = await connect();
  const challenge = once(peer, "message");
  attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    socket: socket as unknown as GatewayWsTestSocket,
    requestSocket: request.socket,
  });
  await vi.dynamicImportSettled();
  await challenge;
  const handler = attachHandler.mock.calls[0]![0];
  const messages = [{ role: "assistant", content: "é🦞\nready" }];
  const bytes = Buffer.from(JSON.stringify(messages));
  const payload = new SerializedJsonPayload({ messages: new SerializedJsonArray(bytes) });
  const response = { type: "res" as const, id: "history", ok: true, payload };
  // Shared responses own the assembled frame, independent of the worker's input bytes.
  bytes.fill(0);
  const received = once(peer, "message");
  const result = handler.send(response);
  const [data, isBinary] = (await received) as [Buffer, boolean];
  expect(result).toEqual({ kind: "sent", bytes: data.byteLength });
  expect(isBinary).toBe(false);
  expect(JSON.parse(data.toString())).toEqual({ ...response, payload: { messages } });
});

it.each(["small", "large"])("owns and reuses %s compressed segments per window", async (size) => {
  const text =
    size === "large"
      ? randomBytes(64 * 1024).toString("base64")
      : "shared history é🦞 ".repeat(1024);
  const bytes = Buffer.from(JSON.stringify([{ text }]));
  const messages = new SerializedJsonArray(bytes);
  const retained = new Map<number, Uint8Array>();
  for (const windowBits of [15, 10]) {
    const {
      peer: client,
      codec,
      transport,
    } = await connectTransport({ serverMaxWindowBits: windowBits });
    expect(codec).toMatchObject({ acceptsDeflatedSegments: windowBits === 15 });
    const compressed = deflateRawSync(bytes, { level: 1, windowBits, finishFlush });
    expect(compressed.byteLength < Buffer.poolSize >>> 1).toBe(size === "small");
    for (let sequence = 0; sequence < 2; sequence++) {
      const id = `history-${windowBits}-${sequence}`;
      const frame = serializeGatewayFrame({ type: "res", id, ok: true, payload: { messages } });
      const materialize = vi.spyOn(SerializedGatewayFrame.prototype, "toBuffer");
      // Compression retains the shared piece even when a no-writev socket must join it.
      const compress = vi.spyOn(codec, "compress");
      const received = once(client, "message");
      let sent: Promise<void>;
      try {
        sent = send(transport, typeof frame === "string" ? Buffer.from(frame) : frame);
        expect(materialize).not.toHaveBeenCalled();
      } finally {
        materialize.mockRestore();
      }
      const payload = compress.mock.results[0]?.value;
      expect(payload).toBeInstanceOf(SerializedGatewayFrame);
      const segment = (payload instanceof SerializedGatewayFrame ? payload.segments : []).find(
        (chunk): chunk is Buffer => Buffer.isBuffer(chunk) && chunk.equals(compressed),
      );
      compress.mockRestore();
      const [[data, binary]] = await Promise.all([received, sent]);
      expect([binary, data.toString()]).toEqual([false, frame.toString()]);
      const byteLength = compressed.byteLength;
      expect([segment?.byteLength, segment?.buffer.byteLength]).toEqual([byteLength, byteLength]);
      if (sequence === 0) {
        retained.set(windowBits, segment!);
      } else {
        expect(segment).toBe(retained.get(windowBits));
      }
    }
  }
  expect(retained.get(10)).not.toBe(retained.get(15));
});

it.each([15, 10])(
  "compresses offset Uint8Array segments with a %i-bit negotiated window",
  async (windowBits) => {
    const payload = JSON.stringify({ text: "shared broadcast é🦞 ".repeat(200) });
    const storage = new Uint8Array(Buffer.byteLength(payload) + 16).fill(0xff);
    storage.set(Buffer.from(payload), 8);
    const bytes = storage.subarray(8, -8);
    // Preserve a coalesced prefix, a shared large segment, and a single small suffix.
    const frame = new SerializedGatewayFrame([
      bytes.subarray(0, 1),
      bytes.subarray(1, 2),
      bytes.subarray(2, -2),
      bytes.subarray(-2),
    ]);
    const { peer, transport } = await connectTransport({ serverMaxWindowBits: windowBits });
    const received = once(peer, "message");
    transport.send(frame, { binary: false });
    const [data, binary] = await received;
    expect(binary).toBe(false);
    expect(data.toString()).toBe(payload);
  },
);
