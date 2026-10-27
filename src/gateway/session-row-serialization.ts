import type { SessionRow } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

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

/** Immutable row identities own field preparation; fact indexes stay response-local. */
function createSessionRowFactSharing<T extends GatewaySessionRow>() {
  type Fact = { encoded: string; fact: Partial<T>; rows: number | number[] };
  const prepared = new WeakMap<
    T,
    {
      facts: Fact[];
      bytes: number;
      rawBytes: number;
      packed?: { row: GatewaySessionRow; keys: string[] };
    }
  >();
  const share = (sessions: T[]) => {
    // Empty and single-row deltas cannot share facts; keep their prepared wire rows.
    if (sessions.length < 2) {
      return { sessions, sharedFacts: [] };
    }
    type SharedFact = { fact: Partial<T>; rows: number[] };
    const candidates = new Map<string, Fact>();
    const rows: GatewaySessionRow[] = [];
    sessions.forEach((row, index) => {
      const { key, kind, updatedAt, sessionId, rowMode } = row;
      const required = { key, kind, updatedAt, sessionId, rowMode };
      rows.push(required);
      let facts = prepared.get(row)?.facts;
      if (!facts) {
        facts = [];
        let bytes = 0;
        for (const field in row) {
          const value = row[field];
          // Keep required fields and the projection marker readable without expanding the table.
          if (
            value === undefined ||
            ["key", "kind", "updatedAt", "sessionId", "rowMode"].includes(field)
          ) {
            continue;
          }
          const fact: Partial<T> = {};
          fact[field] = value;
          const encoded = JSON.stringify(fact);
          facts.push({ encoded, fact, rows: 0 });
          bytes += encoded.length * 2;
        }
        // Reserve a possible singleton delta without retaining its unused raw JSON.
        // Each optional one-field object contributes its property and one comma.
        const rawBytes = JSON.stringify(required).length * 2 + bytes - facts.length * 2;
        prepared.set(row, { facts, bytes, rawBytes });
      }
      for (const fact of facts) {
        const candidate = candidates.get(fact.encoded);
        if (candidate) {
          if (typeof candidate.rows === "number") {
            candidate.rows = [candidate.rows, index];
          } else {
            candidate.rows.push(index);
          }
        } else {
          fact.rows = index;
          candidates.set(fact.encoded, fact);
        }
      }
    });
    // Facts with the same recipients share one reference, including common scalar defaults.
    const groups = new Map<string, SharedFact>();
    for (const candidate of candidates.values()) {
      const recipients = candidate.rows;
      // Recipient scratch belongs to this response, never to the retained row facts.
      candidate.rows = 0;
      if (typeof recipients === "number") {
        Object.assign(rows[recipients]!, candidate.fact);
        continue;
      }
      const key = recipients.join(",");
      const group = groups.get(key);
      if (group) {
        Object.assign(group.fact, candidate.fact);
      } else {
        groups.set(key, { fact: { ...candidate.fact }, rows: recipients });
      }
    }
    const sharedFacts: Partial<T>[] = [];
    for (const group of groups.values()) {
      const reference = sharedFacts.push(group.fact) - 1;
      for (const index of group.rows) {
        (rows[index]!.sharedFacts ??= []).push(reference);
      }
    }
    for (let index = 0; index < rows.length; index++) {
      const retained = prepared.get(sessions[index]!)!;
      const row = rows[index]!;
      const previous = retained.packed;
      let keyCount = 0;
      for (const key in row) {
        if (key !== previous?.keys[keyCount++]) {
          keyCount = -1;
          break;
        }
      }
      // The immutable source owns values; only field order and response-local fact indexes
      // can change its packed bytes. Retain one layout, never a cache of list shapes.
      if (
        previous &&
        previous.keys.length === keyCount &&
        previous.row.sharedFacts?.length === row.sharedFacts?.length &&
        (row.sharedFacts?.every((ref, position) => ref === previous.row.sharedFacts?.[position]) ??
          true)
      ) {
        rows[index] = previous.row;
      } else {
        retained.packed = { row, keys: Object.keys(row) };
      }
    }
    return { sessions: rows, sharedFacts };
  };
  return {
    share,
    encodingBytes: (row: T) => {
      const retained = prepared.get(row);
      return retained
        ? retained.bytes +
            Math.max(0, retained.rawBytes - sessionRowEncodingBytes(row)) +
            (retained.packed ? sessionRowEncodingBytes(retained.packed.row) : 0)
        : 0;
    },
  };
}

export const { share: shareSessionRowFacts, encodingBytes: sessionRowFactEncodingBytes } =
  createSessionRowFactSharing<GatewaySessionRow>();
