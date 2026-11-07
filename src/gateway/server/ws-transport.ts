import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { SerializedGatewayFrame } from "../serialized-json.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";
import type { installGatewayDeflateCodec } from "./ws-compression.js";
import { recordGatewayWsEvent } from "./ws-connection-diagnostics.js";

// Payload identity owns framing; compression negotiation chooses the payload before lookup.
const rawHeaders = new WeakMap<Buffer | SerializedGatewayFrame, Buffer>();
const compressedHeaders = new WeakMap<Buffer | SerializedGatewayFrame, Buffer>();

/** Own outbound compression and socket batching for every frame. */
export function createGatewayWebSocketTransport(
  socket: WebSocket,
  stream: Socket,
  compression: ReturnType<typeof installGatewayDeflateCodec>,
): GatewayConnectionTransport {
  // oxlint-disable-next-line no-underscore-dangle -- Writable's documented vector hook is absent on Bun HTTP sockets.
  const nativeWritev = stream._writev !== undefined;
  const write = stream.write.bind(stream);
  let batch: { chunks: Uint8Array[]; callbacks: ((error?: Error | null) => void)[] } | undefined;
  let pendingBytes = 0;
  let batched = false;
  const uncorkBatch = () => {
    batched = false;
    stream.uncork();
  };
  // Pinned Bun HTTP sockets disable _writev. Keep one copy per burst there;
  // replacing _writev itself could consume Bun's queued HTTP response operations.
  if (!nativeWritev) {
    stream.write = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      const done = typeof encoding === "function" ? encoding : callback;
      const charset = typeof encoding === "string" ? encoding : "utf8";
      if (!batch) {
        return write(chunk, charset, done);
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, charset) : chunk;
      batch.chunks.push(bytes);
      pendingBytes += bytes.byteLength;
      if (done) {
        batch.callbacks.push(done);
      }
      return stream.writableLength + pendingBytes < stream.writableHighWaterMark;
    };
  }
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount + pendingBytes;
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
      if (!nativeWritev) {
        if (!batch) {
          batch = { chunks: [], callbacks: [] };
          process.nextTick(() => {
            const queued = batch!;
            batch = undefined;
            const bytes = pendingBytes;
            pendingBytes = 0;
            if (queued.chunks.length > 0) {
              write(Buffer.concat(queued.chunks, bytes), "utf8", (error) => {
                for (const callback of queued.callbacks) {
                  callback(error);
                }
              });
            }
          });
        }
        return;
      }
      if (!batched) {
        batched = true;
        stream.cork();
        process.nextTick(uncorkBatch);
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
        const headers = compressed ? compressedHeaders : rawHeaders;
        let header = headers.get(payload);
        if (!header) {
          header = Buffer.allocUnsafe(bytes < 126 ? 2 : bytes < 65536 ? 4 : 10);
          header[0] = compressed ? 0xc1 : 0x81;
          header[1] = bytes < 126 ? bytes : bytes < 65536 ? 126 : 127;
          if (header.length === 4) {
            header.writeUInt16BE(bytes, 2);
          } else if (header.length === 10) {
            header.writeBigUInt64BE(BigInt(bytes), 2);
          }
          headers.set(payload, header);
        }
        if (!nativeWritev && !batch) {
          stream.write(
            Buffer.concat([header, ...segments], header.length + bytes),
            "utf8",
            complete,
          );
          return bytes;
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
