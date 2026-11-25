import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isPendingBackgroundResultMessage,
  readBackgroundResultPlacement,
} from "../../../packages/agent-core/src/harness/session/background-result-placement.js";

/** Reserve accepted artifacts before filling the ordinary suffix; a placement owns its payload cost. */
export function fitBackgroundResultDependencies(
  selected: readonly { seq: number; serialized_bytes: number }[],
  candidates: readonly { seq: number; serialized_bytes: number; event: unknown }[],
  headerBytes: number,
  maxBytes?: number,
): {
  rows: { seq: number; serialized_bytes: number }[];
  serializedBytes: number;
  truncated: boolean;
} {
  return fitBackgroundResultDependencyFacts(
    selected,
    candidates.map((row) => {
      const entry = asOptionalRecord(row.event);
      return {
        ...row,
        type: entry?.type,
        id: entry?.id,
        pending: entry?.type === "message" && isPendingBackgroundResultMessage(entry.message),
        placement: readBackgroundResultPlacement(entry)?.resultEntryIds,
      };
    }),
    headerBytes,
    maxBytes,
  );
}

/** The native compaction reader supplies navigation facts, never payload-shaped entries. */
export function fitBackgroundResultDependencyFacts(
  selected: readonly { seq: number; serialized_bytes: number }[],
  candidates: readonly {
    seq: number;
    serialized_bytes: number;
    type: unknown;
    id: unknown;
    pending: boolean;
    placement?: readonly string[];
  }[],
  headerBytes: number,
  maxBytes?: number,
): {
  rows: { seq: number; serialized_bytes: number }[];
  serializedBytes: number;
  truncated: boolean;
} {
  const placements = new Map<number, readonly string[]>();
  const sources = new Map<string, (typeof candidates)[number]>();
  const pending = new Map<string, (typeof candidates)[number]>();
  for (const row of candidates) {
    if (row.type === "reset" || row.type === "branch_summary") {
      pending.clear();
    }
    if (row.pending && typeof row.id === "string") {
      sources.set(row.id, row);
      pending.set(row.id, row);
    }
    if (row.placement) {
      placements.set(row.seq, row.placement);
      for (const id of row.placement) {
        pending.delete(id);
      }
    }
  }
  if (sources.size === 0 && placements.size === 0) {
    return {
      rows: [...selected],
      serializedBytes:
        headerBytes + selected.reduce((total, row) => total + row.serialized_bytes, 0),
      truncated: false,
    };
  }
  const retained = new Map<number, { seq: number; serialized_bytes: number }>();
  let serializedBytes = headerBytes;
  for (const row of pending.values()) {
    retained.set(row.seq, row);
    serializedBytes += row.serialized_bytes;
  }
  if (maxBytes !== undefined && serializedBytes > maxBytes) {
    throw new RangeError("Required background result payload exceeds the session context limit");
  }
  let truncated = false;
  for (const row of selected.toSorted((left, right) => right.seq - left.seq)) {
    const additions = new Map<number, { seq: number; serialized_bytes: number }>();
    if (!retained.has(row.seq)) {
      additions.set(row.seq, row);
    }
    for (const id of placements.get(row.seq) ?? []) {
      const source = sources.get(id);
      if (!source) {
        throw new Error(`Background result placement payload is unavailable: ${id}`);
      }
      if (!retained.has(source.seq)) {
        additions.set(source.seq, source);
      }
    }
    const bytes = [...additions.values()].reduce(
      (total, addition) => total + addition.serialized_bytes,
      0,
    );
    if (maxBytes !== undefined && serializedBytes + bytes > maxBytes) {
      truncated = true;
      break;
    }
    for (const addition of additions.values()) {
      retained.set(addition.seq, addition);
    }
    serializedBytes += bytes;
  }
  return {
    rows: [...retained.values()].toSorted((left, right) => left.seq - right.seq),
    serializedBytes,
    truncated,
  };
}
