import { closeSync, fstatSync, openSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  databaseFileIdentityKey,
  readDatabaseIdentityBirthtime,
} from "../infra/sqlite-worker-identity.js";
import {
  getOpenedStateDatabaseIdentity,
  type OpenedStateDatabaseIdentity,
} from "./openclaw-state-db-handle.js";

/**
 * Process-wide receipts for a completed full shared-state integrity proof.
 *
 * Worker threads do not share module state, so a per-handle cache never helps a fresh worker: every
 * worker that admits the shared-state database would otherwise repeat a whole-file
 * integrity_check + foreign_key_check. The receipt table is a SharedArrayBuffer published through
 * worker_threads environment data, so every worker spawned after the first loader (normally the
 * Gateway main thread) reads and writes the same table.
 *
 * Invalidation contract: a receipt names the physical file the connection actually has open --
 * the identity bound at native open time by the handle owner, never a fresh stat of the pathname,
 * which may since have been renamed over -- plus the schema cookie. A connection whose opened
 * identity could not be bound has no receipt at all: it never reads one and never mints one. A
 * replaced or recreated file, a different path, or any schema change misses the receipt and runs
 * the full check again. Any failed check clears every receipt in the process, and a check that was
 * already running when that happened cannot mint one afterwards (clear generation). Only an
 * outermost read transaction may mint a receipt, because a nested check can observe uncommitted
 * pages that later roll back. A new process always starts with no receipts.
 *
 * Reused inodes: Linux gives this process no trustworthy creation time (the identity policy pins
 * birthtime to "0"), so dev + inode + path + schema cookie alone would be satisfiable again by a
 * different file once the last descriptor on the proved file closed. Minting therefore retains an
 * open read descriptor on the proved file for the receipt's lifetime. Node worker threads share one
 * OS process file-descriptor table, so a live pin makes POSIX reuse of that inode impossible
 * process-wide while the receipt is honoured anywhere in the process.
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

// Descriptors this thread retains on files it proved, keyed by the receipt key text.
const pinnedProvedFiles = new Map<string, number>();

type ReceiptEntry = {
  readonly identity: OpenedStateDatabaseIdentity;
  readonly keyText: string;
  readonly key: Uint8Array;
};

/**
 * Derive the receipt key from the identity bound when this connection opened, so both lookup and
 * publication name the file the connection actually has open. No bound identity means no lookup, no
 * publication, and a full check every time.
 */
function readReceiptEntry(database: DatabaseSync, schemaCookie: unknown): ReceiptEntry | undefined {
  if (typeof schemaCookie !== "number") {
    return undefined;
  }
  const identity = getOpenedStateDatabaseIdentity(database);
  if (!identity?.key.startsWith("file:")) {
    return undefined;
  }
  const keyText = [identity.key, identity.birthtime, identity.canonicalPath, schemaCookie].join(
    "|",
  );
  const key = new TextEncoder().encode(keyText);
  return key.byteLength <= SLOT_BYTES - HEADER_BYTES ? { identity, keyText, key } : undefined;
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

/**
 * Retain a read descriptor on the proved file, refusing unless the file now at the proved canonical
 * path is still exactly the file that was proved. That refusal is also what catches a file swapped
 * underneath the running check, which is why no second path stat is needed afterwards.
 *
 * Bounded residual: a pin minted by a worker thread that exits without clearing stays open until
 * the process exits. That is one leaked descriptor per proved file, never weaker trust -- an
 * outliving pin only keeps the proved inode unreusable, which is the invariant itself.
 */
function pinProvedFile(entry: ReceiptEntry): boolean {
  if (pinnedProvedFiles.has(entry.keyText)) {
    return true;
  }
  // Pins are capped with the slot table: a full table only costs a repeated full check.
  if (pinnedProvedFiles.size >= SLOT_COUNT) {
    return false;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(entry.identity.canonicalPath, "r");
    const file = fstatSync(descriptor, { bigint: true });
    if (
      !file.isFile() ||
      `file:${databaseFileIdentityKey(file)}` !== entry.identity.key ||
      readDatabaseIdentityBirthtime(file) !== entry.identity.birthtime
    ) {
      closeSync(descriptor);
      return false;
    }
    pinnedProvedFiles.set(entry.keyText, descriptor);
    return true;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A descriptor that cannot be closed is not a reason to fail an admission.
      }
    }
    return false;
  }
}

function releasePinnedProvedFiles(): void {
  for (const descriptor of pinnedProvedFiles.values()) {
    try {
      closeSync(descriptor);
    } catch {
      // Already closed or unclosable: the receipt is gone either way.
    }
  }
  pinnedProvedFiles.clear();
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
  // Nothing this thread proved is trusted any more, so nothing needs its inode held.
  releasePinnedProvedFiles();
}

/** Run the full integrity proof once per process for one physical file generation and schema. */
export function assertOpenClawStateIntegrityOncePerFileGeneration(
  database: DatabaseSync,
  pathname: string,
  schemaCookie: unknown,
  options: { mayRecordReceipt: boolean },
): void {
  const generation = Atomics.load(words, GENERATION);
  const entry = readReceiptEntry(database, schemaCookie);
  if (entry && hasReceipt(entry.key)) {
    return;
  }
  try {
    assertSqliteIntegrity(database, pathname);
  } catch (error) {
    clearOpenClawStateIntegrityReceipts();
    throw error;
  }
  if (!entry || !options.mayRecordReceipt) {
    return;
  }
  // Publish only while holding the proved file open: that binds the receipt to one physical file
  // generation on platforms whose creation time this process cannot trust.
  if (!pinProvedFile(entry)) {
    return;
  }
  recordReceipt(entry.key, generation);
}
