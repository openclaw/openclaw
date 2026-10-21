import { hash } from "node:crypto";

export type SessionRowDeltaFields = {
  readonly hashes: ReadonlyMap<string, bigint>;
  readonly fieldCount: number;
};

type SessionRowDelta = { set: Record<string, unknown>; remove: string[] };

const preparedRows = new WeakMap<object, SessionRowDeltaFields>();

/** Keep JSON's omission/null semantics while ignoring nested object key order. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** Presented row identity is immutable; its vector never retains row contents. */
export function prepareSessionRowDeltaFields(row: Record<string, unknown>): SessionRowDeltaFields {
  const cached = preparedRows.get(row);
  if (cached) {
    return cached;
  }
  const hashes = new Map<string, bigint>();
  for (const [field, value] of Object.entries(row)) {
    const encoded = canonicalJson(value);
    if (encoded !== undefined) {
      // Accepted: a 64-bit collision can omit a changed field, ~2^-64 per comparison.
      hashes.set(field, hash("sha256", encoded, "buffer").readBigUInt64BE());
    }
  }
  const prepared = { hashes, fieldCount: hashes.size };
  preparedRows.set(row, prepared);
  return prepared;
}

/** A publication owns patches; identical recipient baselines share comparison work. */
export function createSessionRowDeltaDiffer() {
  const pairs = new WeakMap<
    SessionRowDeltaFields,
    WeakMap<SessionRowDeltaFields, SessionRowDelta>
  >();
  return (
    previous: SessionRowDeltaFields,
    current: SessionRowDeltaFields,
    row: Record<string, unknown>,
  ): SessionRowDelta => {
    let next = pairs.get(previous);
    const cached = next?.get(current);
    if (cached) {
      return cached;
    }
    const set: Record<string, unknown> = {};
    for (const [field, valueHash] of current.hashes) {
      if (previous.hashes.get(field) !== valueHash) {
        Object.defineProperty(set, field, {
          value: row[field],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    const remove: string[] = [];
    for (const field of previous.hashes.keys()) {
      if (!current.hashes.has(field)) {
        remove.push(field);
      }
    }
    const delta = { set, remove };
    if (!next) {
      next = new WeakMap();
      pairs.set(previous, next);
    }
    next.set(current, delta);
    return delta;
  };
}
