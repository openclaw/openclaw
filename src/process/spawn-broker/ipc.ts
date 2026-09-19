import type { SendHandle, Serializable } from "node:child_process";
import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { SpawnBrokerError } from "./protocol.js";

const FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 1024;
const FRAME_KIND = "openclaw-spawn-broker-frame";

type IpcSender = (
  message: Serializable,
  handle: SendHandle | undefined,
  callback: (error: Error | null) => void,
) => void;
type Frame = { kind: typeof FRAME_KIND; id: number; total: number; offset: number; bytes: Buffer };
export type BrokerPublisher = (message: Serializable) => Promise<void>;

/** Frame large inputs/results while bounding both native writes and retained payloads. */
export function createBrokerSender(send: IpcSender) {
  let bytes = 0;
  let messages = 0;
  let sequence = 0;
  let previous = Promise.resolve();
  const write = (message: Serializable, handle?: SendHandle) =>
    new Promise<void>((resolve, reject) => {
      try {
        send(message, handle, (error) => (error ? reject(error) : resolve()));
      } catch (error) {
        reject(toErrorObject(error, "Spawn broker IPC write failed"));
      }
    });
  const enqueue = <T>(size: number, operation: () => Promise<T>): Promise<T> => {
    if (bytes + size > MAX_PENDING_BYTES || messages >= MAX_PENDING_MESSAGES) {
      return Promise.reject(new SpawnBrokerError("Spawn broker IPC capacity exceeded"));
    }
    bytes += size;
    messages += 1;
    const completion = previous.then(operation);
    previous = completion.then(
      () => {},
      () => {},
    );
    return completion.finally(() => {
      bytes -= size;
      messages -= 1;
    });
  };
  const sender = (message: Serializable, handle?: SendHandle): Promise<void> => {
    const payload = serialize(message);
    const size = payload.byteLength;
    if (size > FRAME_BYTES && handle) {
      return Promise.reject(
        new SpawnBrokerError("Spawn broker handle metadata exceeds one IPC frame"),
      );
    }
    const id = ++sequence;
    const operation = async () => {
      if (size <= FRAME_BYTES) {
        await write(message, handle);
        return;
      }
      for (let offset = 0; offset < size; offset += FRAME_BYTES) {
        const frame: Frame = {
          kind: FRAME_KIND,
          id,
          total: size,
          offset,
          bytes: payload.subarray(offset, offset + FRAME_BYTES),
        };
        // Finish the request before its cancellation or later IPC messages can arrive.
        await write(frame);
      }
    };
    return enqueue(size, operation);
  };
  return Object.assign(sender, {
    reserve<T>(run: (publish: BrokerPublisher) => Promise<T>): Promise<T> {
      // Prepay a frame before effects begin; later messages cannot consume its capacity.
      return enqueue(FRAME_BYTES, async () => {
        let active = true;
        let publication: Promise<void> | undefined;
        const publish: BrokerPublisher = (message) => {
          if (!active || publication) {
            return Promise.reject(
              new SpawnBrokerError("Spawn broker publication reservation is closed"),
            );
          }
          publication = (async () => {
            if (serialize(message).byteLength > FRAME_BYTES) {
              throw new SpawnBrokerError("Spawn broker reserved publication exceeds one IPC frame");
            }
            await write(message);
          })();
          void publication.catch(() => {});
          return publication;
        };
        try {
          return await run(publish);
        } finally {
          active = false;
          // Even a callback that throws or forgets to await publication retains its write.
          await publication;
        }
      });
    },
  });
}

/** Only the version-matched private peer can supply frames on this channel. */
export function createBrokerReceiver() {
  const pending = new Map<number, { total: number; received: number; chunks: Buffer[] }>();
  let reserved = 0;
  return {
    receive(message: unknown): unknown {
      if (
        !message ||
        typeof message !== "object" ||
        !("kind" in message) ||
        message.kind !== FRAME_KIND
      ) {
        return message;
      }
      // SAFETY: Private-peer frame fields are validated below before allocation or decoding.
      const frame = message as Frame;
      if (
        !Number.isSafeInteger(frame.id) ||
        !Number.isSafeInteger(frame.total) ||
        frame.total <= FRAME_BYTES ||
        frame.total > MAX_PENDING_BYTES ||
        !Number.isSafeInteger(frame.offset) ||
        !Buffer.isBuffer(frame.bytes) ||
        frame.bytes.length === 0 ||
        frame.bytes.length > FRAME_BYTES
      ) {
        throw new SpawnBrokerError("Invalid spawn broker IPC frame");
      }
      let assembly = pending.get(frame.id);
      if (!assembly) {
        if (
          frame.offset !== 0 ||
          pending.size >= MAX_PENDING_MESSAGES ||
          reserved + frame.total > MAX_PENDING_BYTES
        ) {
          throw new SpawnBrokerError("Spawn broker receive capacity exceeded");
        }
        assembly = { total: frame.total, received: 0, chunks: [] };
        pending.set(frame.id, assembly);
        reserved += frame.total;
      }
      if (
        assembly.total !== frame.total ||
        assembly.received !== frame.offset ||
        assembly.received + frame.bytes.length > assembly.total
      ) {
        throw new SpawnBrokerError("Out-of-order spawn broker IPC frame");
      }
      assembly.chunks.push(frame.bytes);
      assembly.received += frame.bytes.length;
      if (assembly.received < assembly.total) {
        return undefined;
      }
      pending.delete(frame.id);
      reserved -= assembly.total;
      return deserialize(Buffer.concat(assembly.chunks, assembly.total));
    },
    clear() {
      pending.clear();
      reserved = 0;
    },
  };
}
