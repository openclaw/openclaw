import { randomUUID } from "node:crypto";
import type { GatewaySessionRow } from "./session-utils.types.js";

const rowIds = new WeakMap<GatewaySessionRow, number>();
const revisions = new WeakMap<GatewaySessionRow[], string>();
let nextRowId = 0;

export type SessionRowGeneration = { revision: string; ids: Float64Array };

export function sessionRowId(row: GatewaySessionRow): number {
  let id = rowIds.get(row);
  if (id === undefined) {
    if (nextRowId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Session row identity space exhausted");
    }
    id = ++nextRowId;
    rowIds.set(row, id);
  }
  return id;
}

export function sessionRowsRevision(rows: GatewaySessionRow[]): string {
  let revision = revisions.get(rows);
  if (revision === undefined) {
    revision = randomUUID();
    revisions.set(rows, revision);
  }
  return revision;
}

export function captureSessionRowGeneration(rows: GatewaySessionRow[]): SessionRowGeneration {
  // Float64 preserves integer identities past 2^32 without retaining their row objects.
  return { revision: sessionRowsRevision(rows), ids: Float64Array.from(rows, sessionRowId) };
}
