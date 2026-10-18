import type { SessionRow } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

const encodings = new WeakMap<SessionRow, string>();

/** Publish an immutable presentation with the bytes prepared by its owner. */
export function registerSessionRowEncoding(row: SessionRow, encoded: string): void {
  encodings.set(row, encoded);
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
