import type { SessionRow } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

const encodings = new WeakMap<SessionRow, string>();

/** Account for already prepared UTF-16 strings without encoding rows just for telemetry. */
export function sessionRowEncodingBytes(row: SessionRow): number {
  return (encodings.get(row)?.length ?? 0) * 2;
}

/** Only the immutable presentation is encoded; recipient-specific wrappers stay private. */
export function serializeSessionRow(row: SessionRow): string {
  let encoded = encodings.get(row);
  if (encoded === undefined) {
    encoded = JSON.stringify(row);
    encodings.set(row, encoded);
  }
  return encoded;
}
