import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { SerializedGatewayFrame } from "../serialized-json.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";
import type { installGatewayDeflateCodec } from "./ws-compression.js";
import { recordGatewayWsEvent } from "./ws-connection-diagnostics.js";

/** Own outbound compression and use the native socket queue for every frame. */
export function createGatewayWebSocketTransport(
  socket: WebSocket,
  stream: Socket,
  compression: ReturnType<typeof installGatewayDeflateCodec>,
): GatewayConnectionTransport {
  let batched = false;
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    acceptsDeflatedSegments: compression?.acceptsDeflatedSegments ?? false,
    recordEventSent(event, frame, sessionEvent, presenceMode, wireBytes) {
      if (
        recordGatewayWsEvent(event, frame.byteLength, sessionEvent, presenceMode) &&
        wireBytes !== undefined
      ) {
        recordGatewayWsEvent(event, 0, undefined, undefined, wireBytes);
      }
    },
    batchWrites() {
      if (!batched) {
        batched = true;
        stream.cork();
        process.nextTick(() => {
          batched = false;
          stream.uncork();
        });
      }
    },
    send(
      frame: string | Buffer | SerializedGatewayFrame,
      options?: { binary: false } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ): number | undefined {
      const done = typeof options === "function" ? options : callback;
      const encoded = typeof frame === "string" ? Buffer.from(frame) : frame;
      if (socket.readyState === socket.OPEN && compression) {
        const complete = done ? (error?: Error | null) => done(error ?? undefined) : undefined;
        const compressed = compression.compress(encoded);
        const payload = compressed ?? encoded;
        const bytes = payload.byteLength;
        const segments = payload instanceof SerializedGatewayFrame ? payload.segments : [payload];
        // Complete server text frames are unmasked. Encode only their RFC 6455
        // header so the native writev queue can borrow the immutable payload segments.
        const header = Buffer.allocUnsafe(bytes < 126 ? 2 : bytes < 65536 ? 4 : 10);
        header[0] = compressed ? 0xc1 : 0x81;
        header[1] = bytes < 126 ? bytes : bytes < 65536 ? 126 : 127;
        if (header.length === 4) {
          header.writeUInt16BE(bytes, 2);
        } else if (header.length === 10) {
          header.writeBigUInt64BE(BigInt(bytes), 2);
        }
        stream.cork();
        stream.write(header, undefined, segments.length === 0 ? complete : undefined);
        for (let index = 0; index < segments.length; index++) {
          stream.write(
            segments[index]!,
            undefined,
            index === segments.length - 1 ? complete : undefined,
          );
        }
        stream.uncork();
        return bytes;
      }
      // Supported codecs never enter ws's async compression queue: ping, close,
      // raw frames and compressed frames all retain the native stream's FIFO.
      socket.send(
        encoded instanceof SerializedGatewayFrame ? encoded.toBuffer() : encoded,
        { binary: false, compress: compression === undefined },
        done,
      );
      return undefined;
    },
    sendUncompressed(frame, callback) {
      socket.send(frame, { compress: false }, callback);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    terminate() {
      socket.terminate();
    },
    on: socket.on.bind(socket),
    off: socket.off.bind(socket),
    once: socket.once.bind(socket),
  };
}
