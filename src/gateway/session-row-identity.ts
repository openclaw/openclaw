import { randomUUID } from "node:crypto";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Owned row JSON must retain property order as well as values, including on full replies. */
function sameRowField(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (!sameRowField(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  const keys = Object.keys(left);
  const previous = Object.keys(right);
  return (
    keys.length === previous.length &&
    keys.every(
      (key, index) =>
        key === previous[index] && sameRowField(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

/** Construct optional facts without deleting properties from the published row's V8 shape. */
export function definedSessionRowFields<T extends Partial<GatewaySessionRow>>(fields: T): T {
  const row = {};
  const descriptor: PropertyDescriptor = {
    value: undefined,
    enumerable: true,
    configurable: true,
    writable: true,
  };
  // Define properties to retain fast layouts without allocating an entry pair per field.
  for (const field of Object.keys(fields)) {
    const value = Reflect.get(fields, field);
    if (value !== undefined) {
      descriptor.value = value;
      Object.defineProperty(row, field, descriptor);
    }
  }
  // SAFETY: Omitting undefined optional facts preserves every retained field's type.
  return row as T;
}

export function definedSessionRowField<K extends keyof GatewaySessionRow>(
  field: K,
  value: GatewaySessionRow[K],
) {
  return value === undefined ? undefined : { [field]: value };
}

/** Clearing a retained fact requires a new layout; ordinary patches reuse its property order. */
export function freezeSessionRowPatch(
  previous: Readonly<GatewaySessionRow>,
  patch: Partial<GatewaySessionRow>,
): Readonly<GatewaySessionRow> {
  let row: GatewaySessionRow | undefined;
  let cleared = false;
  for (const field of Object.keys(patch)) {
    const value: unknown = Reflect.get(patch, field);
    if (
      value === undefined
        ? !Object.hasOwn(previous, field)
        : sameRowField(value, Reflect.get(previous, field))
    ) {
      continue;
    }
    row ??= { ...previous };
    Reflect.set(row, field, freezeTrustedJsonSnapshot(value));
    cleared ||= value === undefined;
  }
  return row ? Object.freeze(cleared ? definedSessionRowFields(row) : row) : previous;
}

/** Previous rows are deeply frozen publications; only new facts need freezing. */
export function freezeSessionRow(
  row: GatewaySessionRow,
  previous?: Readonly<GatewaySessionRow>,
  fields = Object.keys(row),
): Readonly<GatewaySessionRow> {
  for (const field of fields) {
    const current = Reflect.get(row, field);
    if (current && typeof current === "object") {
      const retained = previous && Reflect.get(previous, field);
      Reflect.set(
        row,
        field,
        sameRowField(current, retained) ? retained : freezeTrustedJsonSnapshot(current),
      );
    }
  }
  return Object.freeze(row);
}

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
  const ids = new Float64Array(rows.length);
  for (let index = 0; index < rows.length; index++) {
    ids[index] = sessionRowId(rows[index]!);
  }
  return { revision: sessionRowsRevision(rows), ids };
}
