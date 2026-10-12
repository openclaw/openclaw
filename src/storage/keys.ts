/** Object keys stay portable across local filesystems and object stores. */
export function validateStorageKey(key: string): void {
  if (
    Buffer.byteLength(key) > 512 ||
    !key
      .split("/")
      .every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..")
  ) {
    throw new Error(
      "Storage keys must contain nonempty /-separated letters, digits, dots, underscores or hyphens, without . or .. segments, and be at most 512 bytes.",
    );
  }
}

export function validateStoragePrefix(prefix: string): void {
  if (prefix !== "") {
    validateStorageKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    if (Buffer.byteLength(prefix) > 512) {
      throw new Error("Storage prefixes must be at most 512 bytes.");
    }
  }
}
