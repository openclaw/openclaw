/** Bytes that own their whole ArrayBuffer, so transferring them detaches nothing else. */
export function exclusiveBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  // Views and Node's small pooled Buffers share a backing store; copy those out first.
  return buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
    ? new Uint8Array(buffer)
    : new Uint8Array(bytes);
}
