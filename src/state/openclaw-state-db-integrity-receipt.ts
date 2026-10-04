import { fstatSync, openSync } from "node:fs";
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
 * open read descriptor on the proved file. Node worker threads share one OS process
 * file-descriptor table, so a live retained descriptor makes POSIX reuse of that inode impossible
 * process-wide.
 *
 * Why this module never closes a descriptor: SQLite's default unix VFS takes POSIX fcntl advisory
 * locks, and closing ANY descriptor on an inode cancels every fcntl lock this process holds on that
 * inode. SQLite documents exactly that as a way to corrupt a database ("POSIX advisory locks
 * canceled by a separate thread doing close()"). A fail-closed path must never be able to strip a
 * live connection's SHARED or RESERVED lock, so a database file is opened here at most once per
 * identity and closed nowhere: not on a mismatch, not on an error, and not on a clear. Retention is
 * also the invariant itself, because a held descriptor is what keeps the proved inode unreusable.
 * The cost is bounded by a budget kept in the shared table, because a descriptor opened by a worker
 * thread belongs to the process and outlives that thread: at most SLOT_COUNT retained descriptors
 * per receipt table, claimed once and never given back. A spent budget makes publication refuse for
 * good, so a state file first seen after that -- a restore, a rename-over, a Doctor rebuild -- runs
 * the full check on every admission for the rest of the process, and the inode of a file replaced
 * while proved keeps its disk blocks allocated until the process exits. A repeated full check and
 * at most 32 held inodes, never weaker trust.
 *
 * Known trade, and an open maintainer decision (#118885): an in-place rewrite of the same inode
 * inherits the proof. A "cp backup.db state.db" restore, a "sqlite3 .restore", and in-place page
 * corruption all keep dev + inode + canonical path, and can keep the schema cookie, so within this
 * process a fresh connection can reuse a receipt that the rewritten contents never earned, until
 * the process restarts. Without a receipt every fresh connection re-scans those cases. A
 * maintainer who wants them caught can add size + mtimeNs + ctimeNs from the open bracket to the
 * opened identity and to the receipt key; the cost is losing reuse after every checkpoint, which is
 * the reason it is not done here.
 */
const OPENCLAW_STATE_INTEGRITY_RECEIPTS_ENV_KEY = "openclaw.state.integrityReceipts.v1";

const SLOT_COUNT = 32;
const SLOT_BYTES = 512;
const HEADER_BYTES = 16;
const EMPTY = 0;
const WRITING = 1;
const READY = 2;
// Slot header words: state, sequence, key length, clear generation the receipt was proved under.
// Two table-wide words follow the slots: the current clear generation, and the number of
// descriptors every thread sharing this table has retained between them.
const GENERATION = (SLOT_COUNT * SLOT_BYTES) / 4;
const RETAINED = GENERATION + 1;

/**
 * One table for the whole process whenever environment data is inherited.
 *
 * It can legitimately split: a worker spawned before the first loader of this module never receives
 * the published buffer, and neither does one running a build whose table size differs, so such a
 * thread creates its own table. A split table means per-thread trust -- that thread honours only
 * proofs it made itself, and a clear reaches only that thread's receipts. That is exactly the scope
 * of the per-handle cache this code already lives beside, and it is never a weaker check: a thread
 * with its own table simply misses receipts and runs the full integrity proof again. The retained
 * descriptor budget below lives in the table too, so it splits with it: the bound is SLOT_COUNT
 * descriptors per table, not per process, whenever a thread has to create its own.
 */
function openReceiptTable(): Int32Array {
  const size = SLOT_COUNT * SLOT_BYTES + 8;
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

/**
 * Every descriptor this thread has opened on a database file, in open order, and never closed (see
 * the POSIX advisory-lock note above). The cap is NOT this list's length: descriptors belong to the
 * process and outlive the thread that opened them, while this module's state is per thread, so the
 * budget is counted in the shared table (word RETAINED) by every thread sharing it.
 */
const retainedDescriptors: number[] = [];
// Descriptors retained on files this thread proved, keyed by file identity WITHOUT the schema
// cookie, so repeated DDL on one file reuses its descriptor instead of consuming a new one.
const retainedProvedFiles = new Map<string, number>();
// Identities whose descriptor was opened but disagreed with the proved file: retained, never
// reopened, and never publishable.
const refusedProvedIdentities = new Set<string>();

type ReceiptEntry = {
  readonly identity: OpenedStateDatabaseIdentity;
  readonly identityText: string;
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
  const identityText = [identity.key, identity.birthtime, identity.canonicalPath].join("|");
  const keyText = [identityText, schemaCookie].join("|");
  const key = new TextEncoder().encode(keyText);
  return key.byteLength <= SLOT_BYTES - HEADER_BYTES
    ? { identity, identityText, keyText, key }
    : undefined;
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
 * Retain a read descriptor on the proved file, refusing to publish unless the file now at the
 * proved canonical path is still exactly the file that was proved. That refusal is also what
 * catches a file swapped underneath the running check, which is why no second path stat is needed
 * afterwards.
 *
 * Nothing is closed on any path here. A descriptor opened by a check that then refuses stays open
 * too, because closing it would cancel this process's fcntl locks on whatever file it landed on --
 * including a live connection's locks on a replacement file. The identity behind a refusal is
 * remembered so it is never reopened. Every thread sharing the table draws from one budget of
 * SLOT_COUNT descriptors, because a descriptor opened by a worker outlives that worker: when the
 * budget is spent, publication refuses for good and every admission runs the full check instead.
 */
/**
 * Claim one descriptor from the table-wide budget, or refuse. Nothing ever returns a claim except
 * an open that failed outright, because a retained descriptor is never closed.
 */
function reserveRetainedDescriptor(): boolean {
  for (;;) {
    const used = Atomics.load(words, RETAINED);
    if (used >= SLOT_COUNT) {
      return false;
    }
    if (Atomics.compareExchange(words, RETAINED, used, used + 1) === used) {
      return true;
    }
  }
}

function pinProvedFile(entry: ReceiptEntry): boolean {
  if (retainedProvedFiles.has(entry.identityText)) {
    return true;
  }
  if (refusedProvedIdentities.has(entry.identityText)) {
    return false;
  }
  // Descriptors are capped with the slot table: a spent budget only costs a repeated full check.
  if (!reserveRetainedDescriptor()) {
    return false;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(entry.identity.canonicalPath, "r");
    // Retained from this point on, whatever happens next.
    retainedDescriptors.push(descriptor);
    const file = fstatSync(descriptor, { bigint: true });
    if (
      !file.isFile() ||
      `file:${databaseFileIdentityKey(file)}` !== entry.identity.key ||
      readDatabaseIdentityBirthtime(file) !== entry.identity.birthtime
    ) {
      refusedProvedIdentities.add(entry.identityText);
      return false;
    }
    retainedProvedFiles.set(entry.identityText, descriptor);
    return true;
  } catch {
    if (descriptor === undefined) {
      // openSync itself failed, so no descriptor exists to retain: give the budget back.
      Atomics.sub(words, RETAINED, 1);
    }
    // A late fstat that disagreed by throwing leaves an opened descriptor in the retained list, and
    // this admission simply runs the full check again.
    return false;
  }
}

function publishIntoSlot(slot: number, key: Uint8Array, generation: number): void {
  const base = (slot * SLOT_BYTES) / 4;
  Atomics.add(words, base + 1, 1);
  bytes.set(key, slot * SLOT_BYTES + HEADER_BYTES);
  Atomics.store(words, base + 2, key.byteLength);
  // Tagged with the generation the proof started under, so a clear that races this write still
  // invalidates it: hasReceipt only honours slots from the current generation.
  Atomics.store(words, base + 3, generation);
  Atomics.store(words, base, READY);
}

/**
 * Reuse the oldest READY slot -- lowest sequence, so the least often rewritten -- when every slot
 * is taken. Without this, a long-lived process that proved SLOT_COUNT distinct file/cookie pairs
 * would switch the table off for good. Dropping an older receipt only costs that file a repeated
 * full check; it never weakens one.
 */
function reuseReadySlot(key: Uint8Array, generation: number): void {
  for (let attempt = 0; attempt < SLOT_COUNT; attempt += 1) {
    let victim = -1;
    let lowest = 0;
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const base = (slot * SLOT_BYTES) / 4;
      if (Atomics.load(words, base) !== READY) {
        continue;
      }
      const sequence = Atomics.load(words, base + 1);
      if (victim < 0 || sequence < lowest) {
        victim = slot;
        lowest = sequence;
      }
    }
    if (victim < 0) {
      // Every slot is mid-write in another thread: a repeated full check, nothing worse.
      return;
    }
    const base = (victim * SLOT_BYTES) / 4;
    if (Atomics.compareExchange(words, base, READY, WRITING) !== READY) {
      continue;
    }
    publishIntoSlot(victim, key, generation);
    return;
  }
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
    publishIntoSlot(slot, key, generation);
    return;
  }
  reuseReadySlot(key, generation);
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
  // Retained descriptors are deliberately NOT released here. Closing one would cancel every fcntl
  // lock this process holds on that inode, so a fail-closed clear could strip a live connection's
  // SQLite locks -- the corruption mode described at the top of this file. They stay open for the
  // process lifetime, which only keeps the proved inodes unreusable; no code path may assume a
  // retained descriptor can be released.
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
