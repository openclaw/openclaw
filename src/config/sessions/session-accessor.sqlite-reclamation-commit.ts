import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import {
  runSqliteImmediateTransactionSync,
  withSqliteWriteAdmissionService,
} from "../../infra/sqlite-transaction.js";

const COMMIT_DECISION_TIMEOUT_MS = 5_000;
const WAITING = 0;
const APPROVED = 1;
const REJECTED = 2;
const COMMITTING = 3;
const SETTLED = 4;
const REQUESTED = 5;
const PARENT_RELEASED = 6;
const PARENT_RELEASE_FAILED = 7;

/** Preserve the reclamation owner's context when an unrelated synchronous writer helps. */
export async function withSqliteReclamationAuthorization<T>(
  buffer: SharedArrayBuffer,
  database: DatabaseSync,
  assertCurrent: () => void,
  run: (authorize: () => unknown[]) => Promise<T>,
): Promise<T> {
  const databasePath = database.location();
  if (databasePath === null) {
    throw new Error("SQLite reclamation authorization requires a file-backed database");
  }
  const shared = new Int32Array(buffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let consumed = false;
  let failure: { error: unknown } | undefined;
  let recovered: unknown[] = [];
  const authorize = () => {
    if (failure) {
      throw failure.error;
    }
    if (consumed) {
      return recovered;
    }
    consumed = true;
    try {
      recovered = inOwnerContext(
        authorizeSqliteReclamationCommit,
        buffer,
        databasePath,
        assertCurrent,
      );
      return recovered;
    } catch (error) {
      failure = { error };
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
  Atomics.compareExchange(shared, 0, APPROVED, REJECTED);
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
  if (Atomics.compareExchange(shared, 0, APPROVED, COMMITTING) !== APPROVED) {
    rejectCommit(shared);
    throw new Error("SQLite session reclamation commit was not authorized");
  }
}

/** Publish only after the transaction ended or its connection successfully closed. */
export function markSqliteReclamationSettled(buffer: SharedArrayBuffer | undefined): void {
  if (buffer) {
    const shared = new Int32Array(buffer);
    let current = Atomics.load(shared, 0);
    while (current !== PARENT_RELEASED && current !== PARENT_RELEASE_FAILED) {
      const observed = Atomics.compareExchange(shared, 0, current, SETTLED);
      if (observed === current) {
        Atomics.notify(shared, 0);
        return;
      }
      current = observed;
    }
  }
}

/** Post-commit maintenance must not contend with the parent's own settlement probe. */
export function waitForSqliteReclamationParentRelease(buffer: SharedArrayBuffer): void {
  const shared = new Int32Array(buffer);
  const decision = Atomics.load(shared, 0);
  // Nonmutating requests never ask the parent for commit approval.
  if (decision === WAITING) {
    return;
  }
  if (
    decision !== COMMITTING &&
    decision !== SETTLED &&
    decision !== PARENT_RELEASED &&
    decision !== PARENT_RELEASE_FAILED
  ) {
    throw new Error("SQLite session reclamation commit was not authorized");
  }
  markSqliteReclamationSettled(buffer);
  for (;;) {
    const phase = Atomics.load(shared, 0);
    if (phase === PARENT_RELEASED) {
      return;
    }
    if (phase === PARENT_RELEASE_FAILED) {
      throw new Error("SQLite parent commit-settlement probe did not release its writer lock");
    }
    Atomics.wait(shared, 0, SETTLED);
  }
}

/** Keep the live parent authority current until the Worker's transaction has settled. */
function authorizeSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  databasePath: string,
  assertCurrent: () => void,
): unknown[] {
  const shared = new Int32Array(buffer);
  // The Worker owns the canonical database lease. This short-lived connection
  // only joins its writer lock; it must not bootstrap schemas or registry state.
  let database: DatabaseSync | undefined;
  const recoveredErrors: unknown[] = [];
  let settled = false;
  let failure: { error: unknown } | undefined;
  try {
    database = openNodeSqliteDatabase(databasePath);
    setSqliteBusyTimeout(database, COMMIT_DECISION_TIMEOUT_MS);
    assertCurrent();
    if (Atomics.compareExchange(shared, 0, REQUESTED, APPROVED) !== REQUESTED) {
      throw new Error("SQLite session reclamation commit checkpoint expired");
    }
    Atomics.notify(shared, 0);

    while (!settled) {
      if (Atomics.load(shared, 0) === SETTLED) {
        settled = true;
        break;
      }
      try {
        // The Worker already owns BEGIN IMMEDIATE. Acquiring this lock proves
        // COMMIT, ROLLBACK, or connection close finished, even after abrupt exit.
        runSqliteImmediateTransactionSync(
          database,
          () => {
            settled = true;
          },
          { operationLabel: "session.reclamation.commit-settlement" },
        );
      } catch (error) {
        if (recoveredErrors.length === 0) {
          recoveredErrors.push(error);
        }
        settled ||= database.isOpen && database.isTransaction;
        if (settled) {
          break;
        }
        const decision = Atomics.compareExchange(shared, 0, APPROVED, REJECTED);
        if (decision === SETTLED) {
          settled = true;
          break;
        }
        if (decision !== COMMITTING) {
          Atomics.notify(shared, 0);
          throw error;
        }
        // A failed barrier cannot release live commit authority. The Worker can
        // prove normal settlement even if this connection is unusable; the lock
        // still joins abrupt exit without relying on a queued parent JS callback.
        if (!isSqliteLockError(error)) {
          Atomics.wait(shared, 0, COMMITTING, 10);
        }
      }
    }
  } catch (error) {
    failure = { error };
    rejectCommit(shared);
  } finally {
    let closeFailure: { error: unknown } | undefined;
    try {
      if (database?.isOpen) {
        database.close();
      }
    } catch (error) {
      closeFailure = { error };
    }
    if (settled) {
      // Child settlement alone does not release a probe whose own transaction failed.
      const released = !database?.isOpen || !database.isTransaction;
      Atomics.store(shared, 0, released ? PARENT_RELEASED : PARENT_RELEASE_FAILED);
      Atomics.notify(shared, 0);
      if (closeFailure) {
        recoveredErrors.push(closeFailure.error);
      }
      if (!released) {
        recoveredErrors.push(
          new Error("SQLite commit-settlement probe remains in a transaction after close"),
        );
      }
    } else if (failure && closeFailure) {
      failure = {
        error: new AggregateError([failure.error, closeFailure.error], String(failure.error), {
          cause: failure.error,
        }),
      };
    }
  }
  if (failure) {
    throw failure.error;
  }
  return recoveredErrors;
}
