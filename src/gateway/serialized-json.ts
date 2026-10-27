import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { encodeOwnedBuffer } from "../shared/owned-buffer.js";

const serializedArrays = new WeakMap<
  readonly unknown[],
  { rows?: readonly string[]; bytes?: Uint8Array; retainedBytes: number }
>();
/** Owned immutable segments; only transports that require contiguous bytes materialize them. */
export class SerializedGatewayFrame {
  readonly byteLength: number;
  #buffer?: Buffer;

  constructor(readonly segments: readonly Uint8Array[]) {
    this.byteLength = segments.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }

  toBuffer(): Buffer {
    if (!this.#buffer) {
      const bytes = Buffer.allocUnsafeSlow(this.byteLength);
      let offset = 0;
      for (const segment of this.segments) {
        bytes.set(segment, offset);
        offset += segment.byteLength;
      }
      this.#buffer = bytes;
    }
    return this.#buffer;
  }

  toString(): string {
    return this.toBuffer().toString("utf8");
  }
}

/** Own the optional payload field, including JSON omission, before socket fanout. */
export class SerializedJsonPayload {
  readonly bytes: Uint8Array;

  constructor(payload: unknown) {
    const frame = serializeGatewayFrame({ type: "res", payload });
    const bytes = typeof frame === "string" ? encodeOwnedBuffer(frame) : frame.toBuffer();
    this.bytes = bytes.subarray('{"type":"res"'.length, -1);
  }

  toJSON(): unknown {
    if (this.bytes.byteLength === 0) {
      return undefined;
    }
    return JSON.parse(
      Buffer.from(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
        .subarray(',"payload":'.length)
        .toString("utf8"),
    );
  }
}

/** Retain immutable row encodings; conditional replies may never send the full array. */
export function registerSerializedJsonArray<T>(
  values: readonly T[],
  encodedRows: readonly string[],
): readonly T[] {
  serializedArrays.set(values, {
    rows: encodedRows,
    // Reserve eventual UTF-8 bytes plus string references, without building an unused buffer.
    retainedBytes: encodedRows.reduce(
      (bytes, row) => bytes + Buffer.byteLength(row) + 8,
      2 + Math.max(0, encodedRows.length - 1),
    ),
  });
  return values;
}

export function serializedJsonArrayBytes(values: readonly unknown[]): number {
  return serializedArrays.get(values)?.retainedBytes ?? 0;
}

function arrayBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof SerializedJsonArray) {
    return value.bytes;
  }
  const encoded = Array.isArray(value) ? serializedArrays.get(value) : undefined;
  if (encoded?.rows) {
    const bytes = Buffer.allocUnsafeSlow(encoded.retainedBytes - encoded.rows.length * 8);
    let offset = 1;
    bytes[0] = 91;
    for (let index = 0; index < encoded.rows.length; index++) {
      if (index > 0) {
        bytes[offset++] = 44;
      }
      offset += bytes.write(encoded.rows[index]!, offset);
    }
    bytes[offset] = 93;
    encoded.bytes = bytes;
    encoded.rows = undefined;
  }
  return encoded?.bytes;
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

export function serializeGatewayFrame(value: unknown): string | SerializedGatewayFrame {
  const frame = asOptionalRecord(value);
  const sharedPayload = frame?.type === "res" ? frame.payload : undefined;
  if (
    frame &&
    sharedPayload instanceof SerializedJsonPayload &&
    typeof frame.toJSON !== "function"
  ) {
    const envelope = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "payload"));
    return new SerializedGatewayFrame([
      Buffer.from(JSON.stringify(envelope).slice(0, -1)),
      sharedPayload.bytes,
      Buffer.from("}"),
    ]);
  }
  const payload = frame?.type === "res" ? asOptionalRecord(frame.payload) : undefined;
  // Subscription admission nests the same list response one level below payload.
  const list = payload && asOptionalRecord(Object.getOwnPropertyDescriptor(payload, "list")?.value);
  const initialHistory = payload && asOptionalRecord(payload.initialHistory);
  const history = initialHistory && asOptionalRecord(initialHistory.payload);
  const arrayOwner = [payload, list, history].find(
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
        field === payload
          ? payload
          : field === initialHistory
            ? initialHistory
            : field === arrayOwner
              ? arrayOwner
              : undefined;
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
  return new SerializedGatewayFrame(chunks);
}
