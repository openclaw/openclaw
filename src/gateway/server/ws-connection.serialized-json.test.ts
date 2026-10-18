import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { constants, deflateRawSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import {
  SerializedJsonArray,
  SerializedJsonPayload,
  serializeGatewayFrame,
} from "../serialized-json.js";
import { GATEWAY_PER_MESSAGE_DEFLATE, installGatewayDeflateCodec } from "./ws-compression.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { attachGatewayWsForTest, type GatewayWsTestSocket } from "./ws-connection.test-helpers.js";
import type { GatewayWsMessageHandlerParams } from "./ws-connection/message-handler-types.js";

const attachHandler = vi.hoisted(() => vi.fn<(params: GatewayWsMessageHandlerParams) => void>());
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachHandler,
}));

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
        const [socket] = (await accepted) as [Ws.WebSocket];
        sockets.push(socket);
        expect(installGatewayDeflateCodec(socket)).toEqual({
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
