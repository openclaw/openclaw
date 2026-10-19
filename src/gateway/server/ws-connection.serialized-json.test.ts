import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { constants, deflateRawSync } from "node:zlib";
import { expect, it, vi } from "vitest";
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
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachHandler,
}));

it.each([false, {}, { serverMaxWindowBits: 10 }] as const)(
  "counts raw frame sizes and actual payload bytes with compression %j",
  async (perMessageDeflate) => {
    const observations: DiagnosticEventPayload[] = [];
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
      include: ["gateway.ws.event"],
    });
    const server = new Ws.WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
    });
    await once(server, "listening");
    const accepted = once(server, "connection");
    const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      perMessageDeflate,
    });
    const [socket, request] = (await accepted) as [
      Ws.WebSocket,
      import("node:http").IncomingMessage,
    ];
    await once(peer, "open");
    try {
      const codec = installGatewayDeflateCodec(socket, request.socket)!;
      const transport = createGatewayWebSocketTransport(
        socket,
        request.socket,
        codec.acceptsDeflatedSegments,
        codec.observeFrameBytes,
      );
      const threshold = GATEWAY_PER_MESSAGE_DEFLATE.threshold;
      const frames = [threshold - 1, threshold + 1, threshold + 2].map((bytes) => {
        const envelope = JSON.stringify({ type: "event", event: "chat", payload: "" });
        return Buffer.from(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: "x".repeat(bytes - envelope.length),
          }),
        );
      });
      const before = request.socket.bytesWritten;
      // Back-to-back compressed sends exercise ws's pending-compression queue.
      const sent = Promise.all(
        frames.map(
          (frame) =>
            new Promise<void>((resolve, reject) => {
              transport.send(frame, { binary: false }, (error) =>
                error ? reject(error) : resolve(),
              );
              transport.recordEventSent?.("chat", frame);
            }),
        ),
      );
      // Accepted frames must still be counted while ws drains its closing queue.
      socket.close();
      await sent;
      await yieldImmediate();
      await waitForDiagnosticEventsDrained();
      const events = observations.filter((event) => event.type === "gateway.ws.event");
      const rawBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
      const wireBytes = events.reduce((sum, event) => sum + (event.wireBytes ?? 0), 0);
      // These text frames use a 4-byte raw header, or a 2-byte compressed header.
      const headers = (perMessageDeflate === false ? 12 : 8) + 2; // Empty close frame.
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
      peer.terminate();
      socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);

it("delivers an owned shared history payload as a JSON text frame", async () => {
  const server = new Ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const accepted = once(server, "connection");
  const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(peer, "open");
  const [socket] = (await accepted) as [Ws.WebSocket];
  try {
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
    // Shared responses own the assembled frame, independent of the worker's input bytes.
    bytes.fill(0);
    const received = once(peer, "message");
    const result = handler.send({
      type: "res",
      id: "history",
      ok: true,
      payload,
    });
    const [data, isBinary] = (await received) as [Buffer, boolean];
    expect(result).toEqual({ kind: "sent", bytes: data.byteLength });
    expect(isBinary).toBe(false);
    const plainReceived = once(peer, "message");
    const plainResult = handler.send({ type: "res", id: "plain", ok: true, payload: "é🦞" });
    const [plainData] = (await plainReceived) as [Buffer];
    expect(plainResult).toEqual({ kind: "sent", bytes: plainData.byteLength });
    expect(JSON.parse(data.toString())).toEqual({
      type: "res",
      id: "history",
      ok: true,
      payload: { messages },
    });
  } finally {
    peer.terminate();
    socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it.each(["small", "large"])(
  "retains exact backing and reuses %s compressed segments per window",
  async (size) => {
    const server = new Ws.WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
    });
    const clients: Ws.WebSocket[] = [];
    const sockets: Ws.WebSocket[] = [];
    const text =
      size === "large"
        ? randomBytes(64 * 1024).toString("base64")
        : "shared history é🦞 ".repeat(1024);
    const bytes = Buffer.from(JSON.stringify([{ text }]));
    const messages = new SerializedJsonArray(bytes);
    const retained = new Map<number, Uint8Array>();
    try {
      await once(server, "listening");
      for (const windowBits of [15, 10]) {
        const accepted = once(server, "connection");
        const client = new Ws.WebSocket(
          `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
          {
            perMessageDeflate: { serverMaxWindowBits: windowBits },
          },
        );
        clients.push(client);
        const opened = once(client, "open");
        const [socket, request] = (await accepted) as [
          Ws.WebSocket,
          import("node:http").IncomingMessage,
        ];
        sockets.push(socket);
        expect(installGatewayDeflateCodec(socket, request.socket)).toMatchObject({
          acceptsDeflatedSegments: windowBits === 15,
        });
        await opened;
        const compressed = deflateRawSync(bytes, {
          level: 1,
          windowBits,
          finishFlush: constants.Z_SYNC_FLUSH,
        });
        expect(compressed.byteLength < Buffer.poolSize >>> 1).toBe(size === "small");
        for (let sequence = 0; sequence < 2; sequence++) {
          const frame = serializeGatewayFrame({
            type: "res",
            id: `history-${windowBits}-${sequence}`,
            ok: true,
            payload: { messages },
          });
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
          expect(binary).toBe(false);
          expect(data.toString()).toBe(frame.toString());
          expect(segment).toBeDefined();
          expect(segment!.buffer.byteLength).toBe(segment!.byteLength);
          expect(segment!.byteLength).toBe(compressed.byteLength);
          if (sequence === 0) {
            retained.set(windowBits, segment!);
          } else {
            expect(segment).toBe(retained.get(windowBits));
          }
        }
      }
      expect(retained.get(10)).not.toBe(retained.get(15));
    } finally {
      for (const client of clients) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
