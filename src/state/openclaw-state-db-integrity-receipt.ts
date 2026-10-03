import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { inspectDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";

/**
 * Process-wide receipts for a completed full shared-state integrity proof.
 *
 * Worker threads do not share module state, so a per-handle cache never helps a fresh worker: every
 * worker that admits the shared-state database would otherwise repeat a whole-file
 * integrity_check + foreign_key_check. The receipt table is a SharedArrayBuffer published through
 * worker_threads environment data, so every worker spawned after the first loader (normally the
 * Gateway main thread) reads and writes the same table.
 *
 * Invalidation contract: a receipt names the physical file the connection actually has open
 * (dev, inode, creation time where the platform policy trusts it, canonical path) and the schema
 * cookie. A replaced or recreated file, a different path, or any schema change misses the receipt
 * and runs the full check again. Any failed check clears every receipt in the process, and a check
 * that was already running when that happened cannot mint one afterwards (clear generation). Only an
 * outermost read transaction may mint a receipt, because a nested check can observe uncommitted
 * pages that later roll back. A new process always starts with no receipts.
 */
export const OPENCLAW_STATE_INTEGRITY_RECEIPTS_ENV_KEY = "openclaw.state.integrityReceipts.v1";

const SLOT_COUNT = 32;
const SLOT_BYTES = 512;
const HEADER_BYTES = 16;
const EMPTY = 0;
const WRITING = 1;
const READY = 2;
// Slot header words: state, sequence, key length, clear generation the receipt was proved under.
// One table-wide word after the slots holds the current clear generation.
const GENERATION = (SLOT_COUNT * SLOT_BYTES) / 4;

function openReceiptTable(): Int32Array {
  const size = SLOT_COUNT * SLOT_BYTES + 4;
  try {
    const inherited = getEnvironmentData(OPENCLAW_STATE_INTEGRITY_RECEIPTS_ENV_KEY);
    if (inherited instanceof SharedArrayBuffer && inherited.byteLength === size) {
      return new Int32Array(inherited);
    }
    const created = new SharedArrayBuffer(size);
    setEnvironmentData(OPENCLAW_STATE_INTEGRITY_RECEIPTS_ENV_KEY, created);
    return new Int32Array(created);
  } catch {
    // Without environment data the table stays thread-local: a missed receipt, never a weaker check.
    return new Int32Array(new SharedArrayBuffer(size));
  }
}

const words = openReceiptTable();
const bytes = new Uint8Array(words.buffer);

function readReceiptKey(database: DatabaseSync, schemaCookie: unknown): Uint8Array | undefined {
  if (typeof schemaCookie !== "number") {
    return undefined;
  }
  try {
    const location = database.location();
    const identity = location ? inspectDatabasePathIdentitySync(location) : undefined;
    if (!identity?.key.startsWith("file:")) {
      return undefined;
    }
    const key = new TextEncoder().encode(
      [identity.key, identity.birthtime ?? "", identity.canonicalPath, schemaCookie].join("|"),
    );
    return key.byteLength <= SLOT_BYTES - HEADER_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

function sameKey(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function hasReceipt(key: Uint8Array): boolean {
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const base = (slot * SLOT_BYTES) / 4;
    const sequence = Atomics.load(words, base + 1);
    if (
      Atomics.load(words, base) !== READY ||
      Atomics.load(words, base + 2) !== key.byteLength ||
      Atomics.load(words, base + 3) !== Atomics.load(words, GENERATION)
    ) {
      continue;
    }
    const offset = slot * SLOT_BYTES + HEADER_BYTES;
    if (
      sameKey(bytes.subarray(offset, offset + key.byteLength), key) &&
      Atomics.load(words, base) === READY &&
      Atomics.load(words, base + 1) === sequence
    ) {
      return true;
    }
  }
  return false;
}

function recordReceipt(key: Uint8Array, generation: number): void {
  // A clear since the proof started means another check failed meanwhile: do not re-trust anything.
  if (Atomics.load(words, GENERATION) !== generation || hasReceipt(key)) {
    return;
  }
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const base = (slot * SLOT_BYTES) / 4;
    if (Atomics.compareExchange(words, base, EMPTY, WRITING) !== EMPTY) {
      continue;
    }
    Atomics.add(words, base + 1, 1);
    bytes.set(key, slot * SLOT_BYTES + HEADER_BYTES);
    Atomics.store(words, base + 2, key.byteLength);
    // Tagged with the generation the proof started under, so a clear that races this write still
    // invalidates it: hasReceipt only honours slots from the current generation.
    Atomics.store(words, base + 3, generation);
    Atomics.store(words, base, READY);
    return;
  }
  // A full table only costs a repeated full check; it never weakens one.
}

/** Fail closed: forget every receipt in this process. */
export function clearOpenClawStateIntegrityReceipts(): void {
  // Bump first: every receipt minted under an older generation is dead even if the sweep below
  // skips its slot because another thread is mid-write.
  Atomics.add(words, GENERATION, 1);
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const base = (slot * SLOT_BYTES) / 4;
    if (Atomics.compareExchange(words, base, READY, WRITING) !== READY) {
      continue;
    }
    Atomics.add(words, base + 1, 1);
    Atomics.store(words, base + 2, 0);
    Atomics.store(words, base, EMPTY);
  }
}

/** Run the full integrity proof once per process for one physical file generation and schema. */
export function assertOpenClawStateIntegrityOncePerFileGeneration(
  database: DatabaseSync,
  pathname: string,
  schemaCookie: unknown,
  options: { mayRecordReceipt: boolean },
): void {
  const generation = Atomics.load(words, GENERATION);
  const key = readReceiptKey(database, schemaCookie);
  if (key && hasReceipt(key)) {
    return;
  }
  try {
    assertSqliteIntegrity(database, pathname);
  } catch (error) {
    clearOpenClawStateIntegrityReceipts();
    throw error;
  }
  if (!key || !options.mayRecordReceipt) {
    return;
  }
  // A file swapped underneath the check must not inherit its proof.
  const after = readReceiptKey(database, schemaCookie);
  if (after && sameKey(after, key)) {
    recordReceipt(key, generation);
  }
}
