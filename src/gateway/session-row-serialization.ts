import type { SessionRow } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { registerSerializedJsonArray } from "./serialized-json.js";

const encodings = new WeakMap<SessionRow, { json: string; utf8Bytes?: number }>();

/** Packing can carry forward bytes already owned by the same immutable source row. */
export function registerSerializedSessionRow(
  row: SessionRow,
  encoded: string,
  utf8Bytes: number,
): void {
  encodings.set(row, { json: encoded, utf8Bytes });
}

/** Account for already prepared UTF-16 strings without encoding rows just for telemetry. */
export function sessionRowEncodingBytes(row: SessionRow): number {
  return (encodings.get(row)?.json.length ?? 0) * 2;
}

/** Only the immutable presentation is encoded; recipient-specific wrappers stay private. */
export function serializeSessionRow(row: SessionRow): string {
  let encoded = encodings.get(row);
  if (encoded === undefined) {
    encoded = { json: JSON.stringify(row) };
    encodings.set(row, encoded);
  }
  return encoded.json;
}

/** Reuse row-owned UTF-8 sizes without flattening unchanged JSON prefixes per page. */
export function registerSerializedSessionRowArray(rows: SessionRow[]): void {
  let utf8Bytes = 0;
  const json = rows.map((row) => {
    const encoded = serializeSessionRow(row);
    const retained = encodings.get(row)!;
    utf8Bytes += retained.utf8Bytes ??= Buffer.byteLength(encoded);
    return encoded;
  });
  registerSerializedJsonArray(rows, json, utf8Bytes);
}
