import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

const serializedArrays = new WeakMap<readonly unknown[], Uint8Array>();

/** Register an immutable RPC array with its owner's already encoded row bytes. */
export function registerSerializedJsonArray<T>(
  values: readonly T[],
  encodedRows: readonly string[],
): readonly T[] {
  serializedArrays.set(values, Buffer.from(`[${encodedRows.join(",")}]`));
  return values;
}

function arrayBytes(value: unknown): Uint8Array | undefined {
  return value instanceof SerializedJsonArray
    ? value.bytes
    : Array.isArray(value)
      ? serializedArrays.get(value)
      : undefined;
}

/** The history worker owns these already-validated JSON array bytes. */
export class SerializedJsonArray {
  constructor(readonly bytes: Uint8Array) {}

  materialize(): unknown[] {
    const { bytes } = this;
    const value: unknown = JSON.parse(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"),
    );
    if (!Array.isArray(value)) {
      throw new TypeError("Serialized history JSON must contain an array");
    }
    return value;
  }

  toJSON(): unknown[] {
    return this.materialize();
  }
}

function fieldJson(key: string, value: unknown): string {
  // The wrapper preserves toJSON's field name and ordinary undefined omission.
  return JSON.stringify({ [key]: value }).slice(1, -1);
}

export function serializeGatewayFrame(value: unknown): string | Buffer {
  const frame = asOptionalRecord(value);
  const payload = frame?.type === "res" ? asOptionalRecord(frame.payload) : undefined;
  // Subscription admission nests the same list response one level below payload.
  const list = payload && asOptionalRecord(Object.getOwnPropertyDescriptor(payload, "list")?.value);
  const arrayOwner = [payload, list].find(
    (record) =>
      record &&
      typeof record.toJSON !== "function" &&
      Object.keys(record).some((key) =>
        arrayBytes(Object.getOwnPropertyDescriptor(record, key)?.value),
      ),
  );
  if (
    !frame ||
    !payload ||
    typeof frame.toJSON === "function" ||
    typeof payload.toJSON === "function" ||
    !arrayOwner
  ) {
    return JSON.stringify(value);
  }
  const chunks: Uint8Array[] = [];
  const appendObject = (record: Record<string, unknown>): void => {
    chunks.push(Buffer.from("{"));
    let separator = "";
    for (const key of Object.keys(record)) {
      const field = record[key];
      const rawArray = record === arrayOwner ? arrayBytes(field) : undefined;
      const nestedPayload =
        field === payload ? payload : field === arrayOwner ? arrayOwner : undefined;
      const encoded = rawArray || nestedPayload ? `${JSON.stringify(key)}:` : fieldJson(key, field);
      if (!encoded) {
        continue;
      }
      chunks.push(Buffer.from(`${separator}${encoded}`));
      separator = ",";
      if (rawArray) {
        chunks.push(rawArray);
      } else if (nestedPayload) {
        appendObject(nestedPayload);
      }
    }
    chunks.push(Buffer.from("}"));
  };
  appendObject(frame);
  return Buffer.concat(chunks);
}
