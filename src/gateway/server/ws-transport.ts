import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import type { GatewayConnectionTransport } from "./connection-transport.js";
import { recordGatewayWsEvent } from "./ws-connection-diagnostics.js";

/** Batch ws's encoded frames through the socket's public write API. */
export function createGatewayWebSocketTransport(
  socket: WebSocket,
  stream: Socket,
  acceptsDeflatedSegments: boolean,
  observeFrameBytes?: (frame: Buffer, record: (bytes: number) => void) => void,
): GatewayConnectionTransport {
  const write = stream.write.bind(stream);
  let batch: { chunks: Uint8Array[]; callbacks: ((error?: Error | null) => void)[] } | undefined;
  let pendingBytes = 0;

  stream.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (!batch) {
      return write(
        chunk,
        typeof encoding === "string" ? encoding : "utf8",
        typeof encoding === "function" ? encoding : callback,
      );
    }
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined)
        : chunk;
    batch.chunks.push(bytes);
    pendingBytes += bytes.byteLength;
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) {
      batch.callbacks.push(done);
    }
    return stream.writableLength + pendingBytes < stream.writableHighWaterMark;
  };

  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount + pendingBytes;
    },
    acceptsDeflatedSegments,
    recordEventSent(event, frame, sessionEvent, presenceMode) {
      if (recordGatewayWsEvent(event, frame.byteLength, sessionEvent, presenceMode)) {
        observeFrameBytes?.(frame, (bytes) =>
          recordGatewayWsEvent(event, 0, undefined, undefined, bytes),
        );
      }
    },
    batchWrites() {
      if (batch) {
        return;
      }
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
    },
    send(
      frame: string | Buffer,
      options?: { binary: false } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      if (typeof options === "function") {
        socket.send(frame, options);
      } else if (options) {
        socket.send(frame, options, callback);
      } else {
        socket.send(frame, callback);
      }
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
