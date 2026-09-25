import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { withSqliteWriteAdmissionService } from "../../infra/sqlite-transaction.js";

const COMMIT_DECISION_TIMEOUT_MS = 5_000;
const WAITING = 0;
const REJECTED = 2;
const COMMITTING = 3;
const SETTLED = 4;
const REQUESTED = 5;

/** Preserve the reclamation owner's context when an unrelated synchronous writer helps. */
export async function withSqliteReclamationAuthorization<T>(
  buffer: SharedArrayBuffer,
  database: DatabaseSync,
  assertCurrent: () => void,
  run: (authorize: () => void) => Promise<T>,
): Promise<T> {
  const shared = new Int32Array(buffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let consumed = false;
  let failure: { error: unknown } | undefined;
  const authorize = () => {
    if (failure) {
      throw failure.error;
    }
    if (consumed) {
      return;
    }
    consumed = true;
    try {
      inOwnerContext(() => {
        assertCurrent();
        // Acceptance is the commit edge. Pending revocation wins this race;
        // accepted work keeps its writer permit and lifetime through native settlement.
        if (Atomics.compareExchange(shared, 0, REQUESTED, COMMITTING) !== REQUESTED) {
          throw new Error("SQLite session reclamation commit checkpoint expired");
        }
        Atomics.notify(shared, 0);
      });
    } catch (error) {
      failure = { error };
      rejectCommit(shared);
      throw error;
    }
  };
  const service = () => {
    if (Atomics.load(shared, 0) === REQUESTED) {
      try {
        authorize();
      } catch {
        // Rejection belongs to reclamation; its queued request propagates the error.
      }
    }
  };
  return await withSqliteWriteAdmissionService(database, service, () => run(authorize));
}

function rejectCommit(shared: Int32Array): void {
  Atomics.compareExchange(shared, 0, WAITING, REJECTED);
  Atomics.compareExchange(shared, 0, REQUESTED, REJECTED);
  Atomics.notify(shared, 0);
}

/** Revoke a pending request before a synchronous native close can wait on its writer lock. */
export function revokeSqliteReclamationCommit(buffer: SharedArrayBuffer): void {
  rejectCommit(new Int32Array(buffer));
}

/** Called by the Worker while its deletion transaction still owns the writer lock. */
export function waitForSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  request: () => void,
): void {
  const shared = new Int32Array(buffer);
  if (Atomics.compareExchange(shared, 0, WAITING, REQUESTED) !== WAITING) {
    throw new Error("SQLite session reclamation commit was revoked");
  }
  request();
  Atomics.wait(shared, 0, REQUESTED, COMMIT_DECISION_TIMEOUT_MS);
  if (Atomics.load(shared, 0) !== COMMITTING) {
    rejectCommit(shared);
    throw new Error("SQLite session reclamation commit was not authorized");
  }
}

/** Publish only after the transaction ended or its connection successfully closed. */
export function markSqliteReclamationSettled(buffer: SharedArrayBuffer | undefined): void {
  if (buffer) {
    const shared = new Int32Array(buffer);
    Atomics.store(shared, 0, SETTLED);
    Atomics.notify(shared, 0);
  }
}
