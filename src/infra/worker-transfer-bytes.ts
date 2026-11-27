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
  // Avoid an iterable intermediate: large sliced payloads must not become boxed heap entries.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}
