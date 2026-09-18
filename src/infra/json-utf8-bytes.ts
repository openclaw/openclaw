/** Returns the UTF-8 byte length of JSON.stringify(value), falling back to String(value). */
export function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

/** Best-effort byte count result for bounded JSON traversal. */
export type BoundedJsonUtf8Bytes = {
  /** Bytes counted, or a value greater than the requested max when incomplete. */
  bytes: number;
  /** True when traversal completed without unsupported/circular/over-limit input. */
  complete: boolean;
};

/** Returns JSON UTF-8 byte length, or Infinity when the value cannot serialize safely. */
export function jsonUtf8BytesOrInfinity(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Buffer.byteLength(serialized, "utf8")
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonStringByteLengthUpToLimit(value: string, remainingBytes: number): number {
  // Pre-scan raw UTF-8 only when the code-unit bounds are inconclusive.
  if (
    value.length + 2 > remainingBytes ||
    (value.length * 3 + 2 > remainingBytes && Buffer.byteLength(value, "utf8") + 2 > remainingBytes)
  ) {
    return remainingBytes + 1;
  }
  return jsonUtf8BytesOrInfinity(value);
}

/** Returns the first enumerable own keys in JavaScript enumeration order. */
export function firstEnumerableOwnKeys(value: object, maxKeys: number): string[] {
  const keys: string[] = [];
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      continue;
    }
    keys.push(key);
    if (keys.length >= maxKeys) {
      break;
    }
  }
  return keys;
}

/** Counts JSON UTF-8 bytes up to a hard limit without fully serializing large objects. */
export function boundedJsonUtf8Bytes(value: unknown, maxBytes: number): BoundedJsonUtf8Bytes {
  let bytes = 0;
  const seen = new WeakSet<object>();

  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maxBytes) {
      throw new Error("json_byte_limit_exceeded");
    }
  };

  // Measured payloads are external input (MCP tool listings, tool results) and can nest
  // deeper than the call stack, so traversal runs on an explicit stack (#141306). Leave
  // frames restore `seen` exactly where the recursion's finally blocks did.
  type Frame =
    | { kind: "value"; value: unknown; inArray: boolean }
    | { kind: "array"; items: unknown[]; nextIndex: number }
    | {
        kind: "record";
        record: Record<string, unknown>;
        keys: string[];
        nextIndex: number;
        wroteField: boolean;
      }
    | { kind: "leave"; node: object };

  const frames: Frame[] = [{ kind: "value", value, inArray: false }];

  try {
    let frame: Frame | undefined;
    while ((frame = frames.pop()) !== undefined) {
      if (frame.kind === "leave") {
        seen.delete(frame.node);
        continue;
      }
      if (frame.kind === "array") {
        const { items } = frame;
        if (frame.nextIndex >= items.length) {
          add(1);
          continue;
        }
        const index = frame.nextIndex;
        if (index > 0) {
          add(1);
        }
        frame.nextIndex = index + 1;
        frames.push(frame);
        frames.push({ kind: "value", value: items[index], inArray: true });
        continue;
      }
      if (frame.kind === "record") {
        const { record, keys } = frame;
        let resumed = false;
        while (frame.nextIndex < keys.length) {
          const key = keys[frame.nextIndex];
          frame.nextIndex += 1;
          if (key === undefined) {
            continue;
          }
          const field = record[key];
          if (field === undefined || typeof field === "function" || typeof field === "symbol") {
            continue;
          }
          if (frame.wroteField) {
            add(1);
          }
          frame.wroteField = true;
          add(jsonStringByteLengthUpToLimit(key, maxBytes - bytes));
          add(1);
          frames.push(frame);
          frames.push({ kind: "value", value: field, inArray: false });
          resumed = true;
          break;
        }
        if (!resumed) {
          add(1);
        }
        continue;
      }

      const entry = frame.value;
      const inArray = frame.inArray;
      if (entry === null) {
        add(4);
        continue;
      }
      switch (typeof entry) {
        case "string":
          add(jsonStringByteLengthUpToLimit(entry, maxBytes - bytes));
          continue;
        case "number":
          add(jsonUtf8BytesOrInfinity(Number.isFinite(entry) ? entry : null));
          continue;
        case "boolean":
          add(entry ? 4 : 5);
          continue;
        case "undefined":
        case "function":
        case "symbol":
          if (inArray) {
            add(4);
          }
          continue;
        case "bigint":
          throw new Error("json_byte_length_unsupported");
        case "object":
          break;
      }

      const objectEntry = entry as object;
      if (seen.has(objectEntry)) {
        throw new Error("json_byte_length_circular");
      }
      // Custom toJSON can hide arbitrary work or reshape output, so bounded
      // traversal only handles Date's well-known JSON conversion explicitly.
      if (
        typeof (objectEntry as { toJSON?: unknown }).toJSON === "function" &&
        !(objectEntry instanceof Date)
      ) {
        throw new Error("json_byte_length_custom_to_json");
      }
      seen.add(objectEntry);
      frames.push({ kind: "leave", node: objectEntry });
      if (objectEntry instanceof Date) {
        frames.push({ kind: "value", value: objectEntry.toJSON(), inArray });
        continue;
      }
      if (Array.isArray(objectEntry)) {
        add(1);
        frames.push({ kind: "array", items: objectEntry, nextIndex: 0 });
        continue;
      }

      add(1);
      const record = objectEntry as Record<string, unknown>;
      const keys: string[] = [];
      for (const key in record) {
        if (!Object.prototype.propertyIsEnumerable.call(record, key)) {
          continue;
        }
        keys.push(key);
      }
      frames.push({ kind: "record", record, keys, nextIndex: 0, wroteField: false });
    }
    return { bytes, complete: true };
  } catch {
    return { bytes: Math.max(bytes, maxBytes + 1), complete: false };
  }
}
