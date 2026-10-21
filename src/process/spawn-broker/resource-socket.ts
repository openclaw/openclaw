import type { Socket } from "node:net";
import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createBrokerReceiver, createBrokerSender, MAX_PENDING_BYTES } from "./ipc.js";
import { SpawnBrokerError } from "./protocol.js";

/** Byte transport only: socket closure says nothing about a resource's native lifetime. */
export function createBrokerResourceSocket(
  socket: Socket,
  handlers: { message(value: unknown): void; close(error?: Error): void },
) {
  const receiver = createBrokerReceiver();
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  let stopped = false;
  let failure: Error | undefined;
  let pendingWrite: ((error: Error | null) => void) | undefined;

  const stop = (error?: Error) => {
    if (stopped) {
      return;
    }
    stopped = true;
    failure = error;
    receiver.clear();
    body = undefined;
    pendingWrite?.(error ?? new SpawnBrokerError("Spawn broker resource socket closed"));
    socket.destroy();
  };
  const sender = createBrokerSender((message, _handle, callback) => {
    if (stopped || socket.destroyed) {
      callback(failure ?? new SpawnBrokerError("Spawn broker resource socket closed"));
      return;
    }
    const payload = serialize(message);
    if (payload.length > MAX_PENDING_BYTES) {
      callback(new SpawnBrokerError("Spawn broker resource frame exceeds capacity"));
      return;
    }
    const packet = Buffer.allocUnsafe(4 + payload.length);
    packet.writeUInt32BE(payload.length);
    payload.copy(packet, 4);
    const complete = (error: Error | null) => {
      if (pendingWrite !== complete) {
        return;
      }
      pendingWrite = undefined;
      callback(error);
      if (error) {
        stop(error);
      }
    };
    pendingWrite = complete;
    try {
      socket.write(packet, (error) => complete(error ?? null));
    } catch (error) {
      complete(toErrorObject(error, "Spawn broker resource write failed"));
    }
  });

  socket.on("data", (chunk: Buffer) => {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (stopped) {
          break;
        }
        if (!body) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes !== 4) {
            continue;
          }
          const length = header.readUInt32BE();
          if (length === 0 || length > MAX_PENDING_BYTES) {
            throw new SpawnBrokerError("Invalid spawn broker resource frame length");
          }
          body = Buffer.allocUnsafe(length);
          headerBytes = 0;
        }
        const count = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + count);
        bodyBytes += count;
        offset += count;
        if (bodyBytes !== body.length) {
          continue;
        }
        const decoded: unknown = receiver.receive(deserialize(body));
        body = undefined;
        bodyBytes = 0;
        if (decoded !== undefined) {
          if (!decoded || typeof decoded !== "object" || !("value" in decoded)) {
            throw new SpawnBrokerError("Invalid spawn broker resource message");
          }
          handlers.message(decoded.value);
        }
      }
    } catch (error) {
      stop(toErrorObject(error, "Spawn broker resource read failed"));
    }
  });
  socket.once("end", () =>
    stop(
      body || headerBytes
        ? new SpawnBrokerError("Spawn broker resource socket ended during a frame")
        : undefined,
    ),
  );
  socket.once("error", stop);
  socket.once("close", () => {
    stop();
    handlers.close(failure);
  });
  return {
    async send(value: unknown): Promise<void> {
      if (stopped || socket.destroyed) {
        throw failure ?? new SpawnBrokerError("Spawn broker resource socket closed");
      }
      // An envelope distinguishes an undefined value from an incomplete broker frame.
      await sender({ value });
    },
    close: () => stop(),
  };
}
