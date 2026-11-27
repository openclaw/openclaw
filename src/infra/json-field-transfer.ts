import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Transfer JSON fields without encoding a complete document, including keys and strings.
export const JSON_FIELD_TRANSFER_BYTES = 64 * 1024;
const STRING_CHARS = 8 * 1024;

export type JsonTransferField =
  | { kind: "object" | "array" | "end" }
  | { kind: "key"; value: string; append?: true }
  | { kind: "value"; value: string | number | boolean | null; append?: true };

export function* jsonFieldBatches(value: unknown): Generator<JsonTransferField[]> {
  let batch: JsonTransferField[] = [];
  let bytes = 16;
  for (const field of fields(value)) {
    const size = serialize(field).byteLength + 16;
    if (bytes + size > JSON_FIELD_TRANSFER_BYTES) {
      yield batch;
      batch = [];
      bytes = 16;
    }
    batch.push(field);
    bytes += size;
  }
  if (batch.length) {
    yield batch;
  }
}

function* textFields(kind: "key" | "value", value: string): Generator<JsonTransferField> {
  yield { kind, value: value.slice(0, STRING_CHARS) };
  for (let offset = STRING_CHARS; offset < value.length; offset += STRING_CHARS) {
    yield { kind, value: value.slice(offset, offset + STRING_CHARS), append: true };
  }
}

function* fields(value: unknown): Generator<JsonTransferField> {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    yield* textFields("value", value);
  } else if (value === null || typeof value === "boolean" || typeof value === "number") {
    yield {
      kind: "value",
      value: typeof value === "number" && !Number.isFinite(value) ? null : value,
    };
  } else if (typeof value === "object") {
    yield { kind: Array.isArray(value) ? "array" : "object" };
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        yield* textFields("key", key);
        yield* fields(child);
      }
    }
    yield { kind: "end" };
  } else {
    throw new TypeError(`JSON document contains non-JSON value: ${typeof value}`);
  }
}

function isJsonTransferField(field: unknown): field is JsonTransferField {
  if (!isRecord(field)) {
    return false;
  }
  if (field.kind === "object" || field.kind === "array" || field.kind === "end") {
    return true;
  }
  return (
    (field.kind === "key" || field.kind === "value") &&
    (field.append === undefined || (field.append === true && typeof field.value === "string")) &&
    (typeof field.value === "string" ||
      (field.kind === "value" &&
        (field.value === null ||
          typeof field.value === "boolean" ||
          typeof field.value === "number")))
  );
}

export function createJsonFieldReceiver() {
  let root: unknown;
  let hasRoot = false;
  const stack: Array<{ container: object; key?: string }> = [];
  let pending: { kind: "key" | "value"; chunks: string[] } | undefined;
  const write = (value: unknown) => {
    const parent = stack.at(-1);
    if (parent) {
      if (parent.key === undefined) {
        throw new Error("JSON field has no property key");
      }
      Object.defineProperty(parent.container, parent.key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      parent.key = undefined;
    } else {
      if (hasRoot) {
        throw new Error("JSON transfer has more than one root");
      }
      root = value;
      hasRoot = true;
    }
  };
  const flush = () => {
    if (!pending) {
      return;
    }
    const value = pending.chunks.join("");
    if (pending.kind === "key") {
      const parent = stack.at(-1);
      if (!parent || parent.key !== undefined) {
        throw new Error("JSON property key has no value or container");
      }
      parent.key = value;
    } else {
      write(value);
    }
    pending = undefined;
  };
  return {
    accept(field: unknown) {
      if (!isJsonTransferField(field)) {
        throw new Error("Invalid JSON transfer field");
      }
      if (field.kind === "key" || field.kind === "value") {
        if (field.append) {
          if (!pending || pending.kind !== field.kind || typeof field.value !== "string") {
            throw new Error("Invalid JSON string continuation");
          }
          pending.chunks.push(field.value);
          return;
        }
        flush();
        if (typeof field.value === "string") {
          pending = { kind: field.kind, chunks: [field.value] };
        } else {
          write(field.value);
        }
      } else {
        flush();
        if (field.kind === "end") {
          const parent = stack.pop();
          if (!parent || parent.key !== undefined) {
            throw new Error("JSON container ended with an incomplete field");
          }
        } else {
          const container = field.kind === "array" ? [] : {};
          write(container);
          stack.push({ container });
        }
      }
    },
    finish(): unknown {
      flush();
      if (stack.length) {
        throw new Error("JSON transfer ended with an incomplete container");
      }
      return root;
    },
  };
}
