/** Retained bytes must not pin unrelated allocations in Node's shared Buffer pool. */
export function encodeOwnedBuffer(
  value: string,
  encoding: "utf8" | "utf16le" = "utf8",
): Buffer<ArrayBuffer> {
  const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(value, encoding));
  bytes.write(value, encoding);
  return bytes;
}

/** Copy recycled producer views into storage owned only by the retained value. */
export function copyOwnedBuffer(value: Uint8Array): Buffer<ArrayBuffer> {
  const bytes = Buffer.allocUnsafeSlow(value.byteLength);
  bytes.set(value);
  return bytes;
}
