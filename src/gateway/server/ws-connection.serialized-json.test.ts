import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { constants, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
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
afterEach(async () => {
  for (const socket of connections) {
    socket.terminate();
  }
  connections.clear();
  await promisify(server.close.bind(server))();
});

it.each([false, {}, { serverMaxWindowBits: 10 }] as const)(
  "counts frame and wire bytes with compression %j",
  async (perMessageDeflate) => {
    const observations: DiagnosticEventPayload[] = [];
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
      include: ["gateway.ws.event"],
    });
    const { socket, request } = await connect(perMessageDeflate);
    try {
      const codec = installGatewayDeflateCodec(socket, request.socket)!;
      const transport = createGatewayWebSocketTransport(
        socket,
        request.socket,
        codec.acceptsDeflatedSegments,
        codec.observeFrameBytes,
      );
      const threshold = GATEWAY_PER_MESSAGE_DEFLATE.threshold;
      const envelope = { type: "event", event: "chat", payload: "" };
      const envelopeLength = JSON.stringify(envelope).length;
      const frames = [threshold - 1, threshold + 1, threshold + 2].map((bytes) =>
        Buffer.from(JSON.stringify({ ...envelope, payload: "x".repeat(bytes - envelopeLength) })),
      );
      const before = request.socket.bytesWritten;
      const send = promisify(transport.send.bind(transport));
      // Back-to-back compressed sends exercise ws's pending-compression queue.
      const sent = Promise.all(
        frames.map((frame) => {
          const pending = send(frame, { binary: false });
          transport.recordEventSent?.("chat", frame);
          return pending;
        }),
      );
      // Accepted frames must still be counted while ws drains its closing queue.
      socket.close();
      await sent;
      await yieldImmediate();
      await waitForDiagnosticEventsDrained();
      const events = observations.filter((event) => event.type === "gateway.ws.event");
      const rawBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
      const wireBytes = events.reduce((sum, event) => sum + (event.wireBytes ?? 0), 0);
      const headers = perMessageDeflate === false ? 14 : 10; // Three frame headers + empty close.
      expect(wireBytes).toBe(request.socket.bytesWritten - before - headers);
      expect(events.reduce((sum, event) => sum + event.count, 0)).toBe(3);
      expect(events.reduce((sum, event) => sum + event.bytes, 0)).toBe(rawBytes);
      expect(events.reduce((sum, event) => sum + (event.frameBytes?.["+Inf"] ?? 0), 0)).toBe(3);
      expect(
        events.reduce((sum, event) => sum + (event.frameBytes?.[String(threshold)] ?? 0), 0),
      ).toBe(1);
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

it("delivers an owned shared history payload as a JSON text frame", async () => {
  const { peer, socket } = await connect();
  const challenge = once(peer, "message");
  attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    socket: socket as unknown as GatewayWsTestSocket,
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
  const plainReceived = once(peer, "message");
  const plainResult = handler.send({ type: "res", id: "plain", ok: true, payload: "é🦞" });
  const [plainData] = (await plainReceived) as [Buffer];
  expect(plainResult).toEqual({ kind: "sent", bytes: plainData.byteLength });
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
    const { peer: client, socket, request } = await connect({ serverMaxWindowBits: windowBits });
    expect(installGatewayDeflateCodec(socket, request.socket)).toMatchObject({
      acceptsDeflatedSegments: windowBits === 15,
    });
    const compressed = deflateRawSync(bytes, { level: 1, windowBits, finishFlush });
    expect(compressed.byteLength < Buffer.poolSize >>> 1).toBe(size === "small");
    for (let sequence = 0; sequence < 2; sequence++) {
      const id = `history-${windowBits}-${sequence}`;
      const frame = serializeGatewayFrame({ type: "res", id, ok: true, payload: { messages } });
      let segment: Uint8Array | undefined;
      const concat = Buffer.concat.bind(Buffer);
      // Observe the actual memoized piece when the codec assembles its wire output.
      const assembled = vi.spyOn(Buffer, "concat").mockImplementation((parts, length) => {
        if (parts.length === 3 && Buffer.isBuffer(parts[1]) && parts[1].equals(compressed)) {
          segment = parts[1];
        }
        return concat(parts, length);
      });
      const received = once(client, "message");
      let sent: Promise<void>;
      try {
        sent = new Promise<void>((resolve, reject) => {
          socket.send(frame, { binary: false }, (error) => (error ? reject(error) : resolve()));
        });
      } finally {
        assembled.mockRestore();
      }
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
