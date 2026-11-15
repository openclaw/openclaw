/** Convert bridge and transcript values into detached JSON-compatible data. */
export function toToolSearchJsonSafe(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    return typeof value === "bigint" || typeof value === "function"
      ? String(value)
      : Object.prototype.toString.call(value);
  }
}
