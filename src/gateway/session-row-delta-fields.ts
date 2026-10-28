import { hash } from "node:crypto";
import { memoizeFrozenPlainDataProjection } from "../shared/immutable-data.js";

export type SessionRowDeltaFields = {
  readonly fingerprints: ReadonlyMap<string, number | boolean | null | bigint>;
  readonly fieldCount: number;
};

type SessionRowDelta = { set: Record<string, unknown>; remove: string[] };

const preparedRows = new WeakMap<object, SessionRowDeltaFields>();
const revisionSamples = new WeakMap<object, WeakRef<Record<string, unknown>>>();

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

function hashJson(encoded: string | undefined): bigint | undefined {
  if (encoded === undefined) {
    return undefined;
  }
  // Seven ASCII characters plus a leading sentinel fit exactly in a JS number.
  // Negative integers retain no text and cannot collide with unsigned SHA fingerprints.
  if (encoded.length <= 7) {
    let packed = 1;
    for (let i = 0; i < encoded.length; i++) {
      const code = encoded.charCodeAt(i);
      if (code > 127) {
        packed = 0;
        break;
      }
      packed = packed * 128 + code;
    }
    if (packed) {
      return -BigInt(packed);
    }
  }
  // Accepted: a 64-bit collision can omit a changed field, ~2^-64 per comparison.
  return hash("sha256", encoded, "buffer").readBigUInt64BE();
}

// Frozen field identities survive row clock/revision changes; retain only their hashes.
const fingerprintObject = memoizeFrozenPlainDataProjection((value: object) =>
  hashJson(canonicalJson(value)),
);

/** Presented row identity is immutable; fingerprints retain no row objects or text. */
export function prepareSessionRowDeltaFields(
  row: Record<string, unknown>,
  source?: Record<string, unknown>,
): SessionRowDeltaFields {
  const cached = preparedRows.get(row);
  if (cached) {
    return cached;
  }
  // Reuse an existing presentation's vector without retaining its row or a second source vector.
  const sample = source && revisionSamples.get(source)?.deref();
  const sampleFields = sample && preparedRows.get(sample);
  const fingerprints = new Map<string, number | boolean | null | bigint>();
  for (const field of Object.keys(row)) {
    const value = row[field];
    if (sampleFields && value === sample[field]) {
      const fingerprint = sampleFields.fingerprints.get(field);
      if (fingerprint !== undefined) {
        fingerprints.set(field, fingerprint);
      }
      continue;
    }
    if (value === null || typeof value === "boolean") {
      fingerprints.set(field, value);
    } else if (typeof value === "number") {
      // JSON treats nonfinite numbers as null and both zero signs identically.
      fingerprints.set(field, Number.isFinite(value) ? value : null);
    } else {
      const valueFingerprint =
        typeof value === "object" ? fingerprintObject(value) : hashJson(JSON.stringify(value));
      if (valueFingerprint !== undefined) {
        fingerprints.set(field, valueFingerprint);
      }
    }
  }
  const prepared = { fingerprints, fieldCount: fingerprints.size };
  preparedRows.set(row, prepared);
  // Keep one weak sample per immutable materialized revision; collected samples recompute normally.
  if (source && !sample) {
    revisionSamples.set(source, new WeakRef(row));
  }
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
    for (const [field, fingerprint] of current.fingerprints) {
      if (previous.fingerprints.get(field) !== fingerprint) {
        Object.defineProperty(set, field, {
          value: row[field],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    const remove: string[] = [];
    for (const field of previous.fingerprints.keys()) {
      if (!current.fingerprints.has(field)) {
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
