// Minimal openclaw/tunnel/1 client for tests: dials the tunnel child directly
// (no relay) with the same binding and speaks HEAD + DATA / WS frames.
import { randomBytes } from "node:crypto";
import {
  decodeWsMessage,
  encodeHead,
  encodeWsMessage,
  parseResponseHead,
  TUNNEL_ALPN,
  type HeaderPair,
  type TunnelResponseHead,
  type WsMessage,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import type { IrohBinding, IrohRecvStream, IrohSendStream } from "./addon.js";
import { FrameReader, writeDataFrames, writeFrame } from "./frames.js";

type ClientEndpoint = {
  id(): string;
  connect(
    endpointId: string,
    alpn: Uint8Array,
    opts?: { directAddrs?: string[] },
  ): Promise<ClientConnection>;
  close(): Promise<void>;
};

type ClientConnection = {
  openBi(): Promise<{ send: IrohSendStream; recv: IrohRecvStream }>;
  close(code: number, reason: string): void;
  closed(): Promise<{ code?: number; reason: string; kind: string }>;
};

/** A test device: its own endpoint key W and a direct connection to the claw. */
export async function createTunnelTestClient(binding: IrohBinding) {
  const endpoint = (await binding.bind({
    secretKey: randomBytes(32),
    bindAddr: "127.0.0.1:0",
  })) as unknown as ClientEndpoint;
  return {
    peerKey: `iroh:${endpoint.id()}`,
    async connect(serverKey: string, directAddrs: string[]) {
      const conn = await endpoint.connect(
        serverKey.slice("iroh:".length),
        new TextEncoder().encode(TUNNEL_ALPN),
        { directAddrs: directAddrs.filter((addr) => addr.startsWith("127.0.0.1:")) },
      );
      return {
        conn,
        /** One HTTP exchange; resolves with the response head and full body. */
        async http(method: string, path: string, headers: HeaderPair[], body?: Buffer) {
          const { send, recv } = await conn.openBi();
          await writeFrame(send, encodeHead({ kind: "http", method, path, headers }));
          if (body) {
            await writeDataFrames(send, body);
          }
          await send.finish();
          const reader = new FrameReader(recv);
          const headFrame = await reader.next();
          if (!headFrame) {
            throw new Error("stream ended before the response HEAD");
          }
          const head = parseResponseHead(headFrame) as TunnelResponseHead & {
            headers: HeaderPair[];
          };
          const chunks: Buffer[] = [];
          for (let frame = await reader.next(); frame; frame = await reader.next()) {
            chunks.push(frame);
          }
          return { head, body: Buffer.concat(chunks) };
        },
        /** Opens a WebSocket stream; returns helpers to send and receive messages. */
        async ws(path: string, headers: HeaderPair[]) {
          const { send, recv } = await conn.openBi();
          await writeFrame(send, encodeHead({ kind: "ws", path, headers, protocols: [] }));
          const reader = new FrameReader(recv);
          const headFrame = await reader.next();
          const head = headFrame ? parseResponseHead(headFrame) : undefined;
          return {
            head,
            send: (message: WsMessage) => writeFrame(send, encodeWsMessage(message)),
            async next(): Promise<WsMessage | null> {
              const frame = await reader.next();
              return frame ? decodeWsMessage(frame) : null;
            },
          };
        },
        /** Opens a stream and sends raw bytes (protocol violation tests). */
        async raw(bytes: Uint8Array) {
          const { send, recv } = await conn.openBi();
          await send.write(bytes);
          await send.finish();
          return recv;
        },
      };
    },
    close: () => endpoint.close(),
  };
}
