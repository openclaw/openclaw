import { isMarkedAsUntransferable } from "node:worker_threads";

/** Only uniquely owned buffers can be transferred; pooled Buffers share unrelated bytes. */
export function ownedWorkerBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    !isMarkedAsUntransferable(bytes.buffer)
  ) {
    return new Uint8Array(bytes.buffer);
  }
  return Uint8Array.from(bytes);
}
