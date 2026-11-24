import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  assertDatabaseFileIdentity,
  isSoleDatabaseFileDescriptor,
  type DatabaseFileIdentity,
} from "./sqlite-worker-identity.js";

const OPEN = 0;
const ADOPTING = 1;
const RETIRING = 2;
const CLOSED = 3;
const FAILED = 4;
const PHASE = 0;
const CANONICAL = 1;
const RACING = 2;
const EMPTY = -1;

/** One physical epoch survives logical generation retirement and structured cloning. */
export type SqliteDescriptorCustody = {
  id: string;
  state: Int32Array<SharedArrayBuffer>;
};

export function createSqliteDescriptorCustody(descriptor: number): SqliteDescriptorCustody {
  const state = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  state[CANONICAL] = descriptor;
  state[RACING] = EMPTY;
  return { id: randomUUID(), state };
}

export function isSqliteDescriptorCustodyOpen(custody: SqliteDescriptorCustody): boolean {
  const phase = Atomics.load(custody.state, PHASE);
  return phase === OPEN || phase === ADOPTING;
}

export function isSqliteDescriptorCustodyClosed(custody: SqliteDescriptorCustody): boolean {
  return Atomics.load(custody.state, PHASE) === CLOSED;
}

/** Called only after fstat verified the incoming descriptor's physical identity. */
export function adoptSqliteDescriptor(custody: SqliteDescriptorCustody, descriptor: number): void {
  const { state } = custody;
  if (Atomics.compareExchange(state, PHASE, OPEN, ADOPTING) !== OPEN) {
    throw new Error("SQLite descriptor custody is not open for adoption");
  }
  try {
    if (
      Atomics.load(state, CANONICAL) === descriptor ||
      Atomics.load(state, RACING) === descriptor
    ) {
      return;
    }
    // All opens are host-owned; the serialized async preparer can overlap only one
    // synchronous first admission. Later opens reuse this physical epoch's custody.
    if (Atomics.load(state, RACING) !== EMPTY) {
      throw new Error("SQLite descriptor custody already owns its racing admission");
    }
    Atomics.store(state, RACING, descriptor);
  } finally {
    Atomics.store(state, PHASE, OPEN);
  }
}

/** The caller must first join every native user and every submitted acquisition. */
export function retireSqliteDescriptorCustody(
  custody: SqliteDescriptorCustody,
  expected: DatabaseFileIdentity,
  options: { requireSoleDescriptor?: boolean },
): boolean {
  const { state } = custody;
  const phase = Atomics.compareExchange(state, PHASE, OPEN, RETIRING);
  if (phase === CLOSED) {
    return false;
  }
  if (phase !== OPEN) {
    throw new Error("SQLite descriptor custody retirement is pending or uncertain");
  }
  try {
    const slots = [CANONICAL, RACING].filter((slot) => Atomics.load(state, slot) >= 0);
    const descriptors = slots.map((slot) => Atomics.load(state, slot));
    const files = descriptors.map((descriptor) => fs.fstatSync(descriptor, { bigint: true }));
    for (const file of files) {
      assertDatabaseFileIdentity(file, expected);
    }
    if (
      files.some((file) => file.nlink > 1n) ||
      (options.requireSoleDescriptor &&
        !isSoleDatabaseFileDescriptor(descriptors[0]!, files[0]!, descriptors))
    ) {
      Atomics.store(state, PHASE, OPEN);
      return false;
    }
    for (const slot of slots) {
      const descriptor = Atomics.load(state, slot);
      // Claim before close: an error can mean the OS already reused the integer.
      // Keep its encoded identity for custody, but never attempt that close again.
      Atomics.store(state, slot, -descriptor - 2);
      fs.closeSync(descriptor);
      Atomics.store(state, slot, EMPTY);
    }
    Atomics.store(state, PHASE, CLOSED);
    return true;
  } catch (error) {
    Atomics.store(state, PHASE, FAILED);
    throw error;
  }
}
