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

  const visit = (entry: unknown, inArray: boolean): void => {
    if (entry === null) {
      add(4);
      return;
    }
    switch (typeof entry) {
      case "string":
        add(jsonStringByteLengthUpToLimit(entry, maxBytes - bytes));
        return;
      case "number":
        add(jsonUtf8BytesOrInfinity(Number.isFinite(entry) ? entry : null));
        return;
      case "boolean":
        add(entry ? 4 : 5);
        return;
      case "undefined":
      case "function":
      case "symbol":
        if (inArray) {
          add(4);
        }
        return;
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
    try {
      if (objectEntry instanceof Date) {
        visit(objectEntry.toJSON(), inArray);
        return;
      }
      if (Array.isArray(objectEntry)) {
        add(1);
        for (let index = 0; index < objectEntry.length; index += 1) {
          if (index > 0) {
            add(1);
          }
          visit(objectEntry[index], true);
        }
        add(1);
        return;
      }

      add(1);
      let wroteField = false;
      const record = objectEntry as Record<string, unknown>;
      for (const key in record) {
        if (!Object.prototype.propertyIsEnumerable.call(record, key)) {
          continue;
        }
        const field = record[key];
        if (field === undefined || typeof field === "function" || typeof field === "symbol") {
          continue;
        }
        if (wroteField) {
          add(1);
        }
        wroteField = true;
        add(jsonStringByteLengthUpToLimit(key, maxBytes - bytes));
        add(1);
        visit(field, false);
      }
      add(1);
    } finally {
      seen.delete(objectEntry);
    }
  };

  try {
    visit(value, false);
    return { bytes, complete: true };
  } catch {
    return { bytes: Math.max(bytes, maxBytes + 1), complete: false };
  }
}

/**
 * Depth-safe byte accounting for already parsed JSON/owned message values.
 * This proves a byte bound, not that downstream recursive serializers can handle
 * the same nesting. Keep the existing best-effort counter contract for its SDK
 * consumers that use it before JSON.stringify or structuredClone.
 */
export function boundedParsedJsonUtf8Bytes(value: unknown, maxBytes: number): BoundedJsonUtf8Bytes {
  let bytes = 0;
  const seen = new WeakSet<object>();
  type Frame =
    | { kind: "value"; value: unknown; inArray: boolean }
    | { kind: "array"; value: unknown[]; index: number }
    | {
        kind: "object";
        value: object;
        keys: Generator<string>;
        wroteField: boolean;
      }
    | { kind: "leave"; value: object };
  const stack: Frame[] = [{ kind: "value", value, inArray: false }];
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maxBytes) {
      throw new Error("json_byte_limit_exceeded");
    }
  };
  function* ownKeys(entry: object): Generator<string> {
    for (const key in entry) {
      if (Object.prototype.propertyIsEnumerable.call(entry, key)) {
        yield key;
      }
    }
  }
  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) {
        break;
      }
      if (frame.kind === "leave") {
        seen.delete(frame.value);
        continue;
      }
      if (frame.kind === "array") {
        if (frame.index >= frame.value.length) {
          add(1);
          seen.delete(frame.value);
          continue;
        }
        if (frame.index > 0) {
          add(1);
        }
        const entry = frame.value[frame.index++];
        stack.push(frame, { kind: "value", value: entry, inArray: true });
        continue;
      }
      if (frame.kind === "object") {
        let next = frame.keys.next();
        while (!next.done) {
          const key = next.value;
          const field: unknown = Reflect.get(frame.value, key);
          if (field !== undefined && typeof field !== "function" && typeof field !== "symbol") {
            if (frame.wroteField) {
              add(1);
            }
            frame.wroteField = true;
            add(jsonStringByteLengthUpToLimit(key, maxBytes - bytes));
            add(1);
            stack.push(frame, { kind: "value", value: field, inArray: false });
            break;
          }
          next = frame.keys.next();
        }
        if (next.done) {
          add(1);
          seen.delete(frame.value);
        }
        continue;
      }
      const entry = frame.value;
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
          if (frame.inArray) {
            add(4);
          }
          continue;
        case "bigint":
          throw new Error("json_byte_length_unsupported");
        case "object":
          break;
      }
      if (seen.has(entry)) {
        throw new Error("json_byte_length_circular");
      }
      // Custom toJSON can reshape output or hide arbitrary work; retain the
      // existing Date-only conversion exception rather than invoking it here.
      if (typeof Reflect.get(entry, "toJSON") === "function" && !(entry instanceof Date)) {
        throw new Error("json_byte_length_custom_to_json");
      }
      seen.add(entry);
      if (entry instanceof Date) {
        stack.push(
          { kind: "leave", value: entry },
          { kind: "value", value: entry.toJSON(), inArray: frame.inArray },
        );
      } else if (Array.isArray(entry)) {
        add(1);
        stack.push({ kind: "array", value: entry, index: 0 });
      } else {
        add(1);
        stack.push({
          kind: "object",
          value: entry,
          keys: ownKeys(entry),
          wroteField: false,
        });
      }
    }
    return { bytes, complete: true };
  } catch {
    return { bytes: Math.max(bytes, maxBytes + 1), complete: false };
  }
}
