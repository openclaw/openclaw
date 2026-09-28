import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

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
  if (
    !frame ||
    !payload ||
    typeof frame.toJSON === "function" ||
    typeof payload.toJSON === "function" ||
    !Object.keys(payload).some(
      (key) => Object.getOwnPropertyDescriptor(payload, key)?.value instanceof SerializedJsonArray,
    )
  ) {
    return JSON.stringify(value);
  }
  const chunks: Uint8Array[] = [];
  const appendObject = (record: Record<string, unknown>, isPayload: boolean): void => {
    chunks.push(Buffer.from("{"));
    let separator = "";
    for (const key of Object.keys(record)) {
      const field = record[key];
      const rawArray = isPayload && field instanceof SerializedJsonArray ? field : undefined;
      const nestedPayload = !isPayload && key === "payload";
      const encoded = rawArray || nestedPayload ? `${JSON.stringify(key)}:` : fieldJson(key, field);
      if (!encoded) {
        continue;
      }
      chunks.push(Buffer.from(`${separator}${encoded}`));
      separator = ",";
      if (rawArray) {
        chunks.push(rawArray.bytes);
      } else if (nestedPayload) {
        appendObject(payload, true);
      }
    }
    chunks.push(Buffer.from("}"));
  };
  appendObject(frame, false);
  return Buffer.concat(chunks);
}
