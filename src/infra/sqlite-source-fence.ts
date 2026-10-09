import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import {
  SOURCE_FENCE_ACCEPTED,
  SOURCE_FENCE_READY,
  type SqliteSourceFence,
  type SqliteSourceFenceDatabase,
  type SqliteSourceFenceGrant,
  type SqliteSourceFenceIdentity,
} from "./sqlite-source-fence-contract.js";
import { assertTransactionUsable, runSqliteReservedTransactionSync } from "./sqlite-transaction.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { assertDatabasePathIdentity } from "./sqlite-worker-identity.js";
import {
  assertSqliteWorkerCommitReceiptPending,
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
  withSqliteWorkerSourceReservations,
} from "./sqlite-worker-operation-admission.js";

const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSourceFenceBindings"),
  () => new WeakMap<DatabaseSync, SqliteSourceFenceIdentity>(),
);

/** Bind once after native admission; later uses carry the captured physical facts. */
function bindSqliteSourceFenceDatabase({ database, identity }: SqliteSourceFenceDatabase): void {
  const previous = bindings.get(database);
  if (previous) {
    if (!sameIdentity(identity, previous)) {
      throw new SqliteWorkerError("SQLite source fence handle changed incarnation", "closed");
    }
    return;
  }
  const location = database.location();
  if (
    isMainThread ||
    !location ||
    !identity.physical.key.startsWith("file:") ||
    !identity.incarnation
  ) {
    throw new Error("SQLite source fences require admitted durable worker handles");
  }
  assertDatabasePathIdentity(location, identity.physical);
  bindings.set(database, structuredClone(identity));
}

function sameIdentity(
  left: SqliteSourceFenceIdentity,
  right: SqliteSourceFenceIdentity | undefined,
): boolean {
  return (
    right !== undefined &&
    left.incarnation === right.incarnation &&
    left.physical.key === right.physical.key &&
    left.physical.birthtime === right.physical.birthtime &&
    left.physical.canonicalPath === right.physical.canonicalPath
  );
}

function readGrant(): SqliteSourceFenceGrant {
  const value = takeSqliteWorkerOperationAdmissionAttachment();
  if (
    !isRecord(value) ||
    value.kind !== "sqlite-source-fence" ||
    value.version !== 1 ||
    !(value.decision instanceof SharedArrayBuffer) ||
    value.decision.byteLength !== 4 ||
    !isRecord(value.destination) ||
    !Array.isArray(value.sources) ||
    typeof value.deadlineNs !== "bigint"
  ) {
    throw new SqliteWorkerError("SQLite source fence grant is unavailable", "closed");
  }
  // SAFETY: The private port carries the host factory's typed grant, never command-supplied authority.
  return value as SqliteSourceFenceGrant;
}

function rollbackReservations(reservations: readonly SqliteSourceFenceDatabase[]): void {
  const failures: unknown[] = [];
  for (const { database } of reservations.toReversed()) {
    try {
      if (database.isOpen && database.isTransaction) {
        database.exec("ROLLBACK");
      }
    } catch (error) {
      failures.push(error);
      try {
        database.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "SQLite source reservation cleanup failed");
  }
}

/**
 * Only empty acquisition attempts retry. All reservations live in this worker;
 * source rollback follows the destination's definitive COMMIT or rollback.
 */
export async function runSqliteSourceFence<T>(
  fence: SqliteSourceFence,
  inOperation: <Result>(operation: () => Result) => Result,
  execute: () => T,
): Promise<T> {
  const grant = inOperation(readGrant);
  if (
    isMainThread ||
    fence.sources.length === 0 ||
    !sameIdentity(fence.destination.identity, grant.destination) ||
    fence.sources.length !== grant.sources.length ||
    fence.sources.some((source, index) => !sameIdentity(source.identity, grant.sources[index]))
  ) {
    throw new SqliteWorkerError("SQLite source fence differs from its retained owners", "closed");
  }
  // Prefer the destination handle when a source is an alias of the destination.
  const physical = new Map<string, SqliteSourceFenceDatabase>();
  for (const source of [fence.destination, ...fence.sources]) {
    bindSqliteSourceFenceDatabase(source);
    const previous = physical.get(source.identity.physical.key);
    if (previous && previous.identity.physical.birthtime !== source.identity.physical.birthtime) {
      throw new SqliteWorkerError("SQLite source fence aliases changed incarnation", "closed");
    }
    physical.set(source.identity.physical.key, previous ?? source);
  }
  const ordered = [...physical.values()].toSorted((a, b) =>
    a.identity.physical.key < b.identity.physical.key ? -1 : 1,
  );
  const captured = new Set([fence.destination, ...fence.sources]);
  const resolve = (source: SqliteSourceFenceDatabase) => {
    if (!captured.has(source)) {
      throw new SqliteWorkerError("SQLite source is outside this fence", "closed");
    }
    return physical.get(source.identity.physical.key)!.database;
  };
  const decision = new Int32Array(grant.decision);
  const assertReady = () => {
    if (
      Atomics.load(decision, 0) !== SOURCE_FENCE_READY ||
      process.hrtime.bigint() >= grant.deadlineNs
    ) {
      throw new SqliteWorkerError("SQLite source fence authority expired", "closed");
    }
    for (const { database } of captured) {
      assertTransactionUsable(database);
      if (!database.isOpen) {
        throw new SqliteWorkerError("SQLite source fence owner is closed", "closed");
      }
    }
  };
  // All code loading, physical/schema admission and host policy precede reservations.
  inOperation(() =>
    requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: "sqlite-source-fence" }),
  );
  for (;;) {
    let entered = false;
    try {
      return inOperation(() => {
        let cleanupFailure: { error: unknown } | undefined;
        let committedResult: T;
        try {
          // Publication follows source release, so reentrant observers own ordinary writes.
          committedResult = withSqlitePostCommitPublications(fence.destination.database, () =>
            withSqliteWorkerSourceReservations(() => {
              assertReady();
              if ([...captured].some(({ database }) => database.isTransaction)) {
                throw new SqliteWorkerError(
                  "SQLite source fence cannot join an outer transaction",
                  "closed",
                );
              }
              const reservations: SqliteSourceFenceDatabase[] = [];
              try {
                for (const source of ordered) {
                  runWithSqliteBusyTimeout(source.database, 0, () => {
                    source.database.exec("BEGIN IMMEDIATE");
                    reservations.push(source);
                  });
                }
                entered = true;
                return runSqliteReservedTransactionSync(
                  fence.destination.database,
                  () => {
                    assertReady();
                    const validation: unknown = fence.validate(resolve);
                    if (isPromiseLike(validation)) {
                      throw new Error("SQLite source predicates must remain synchronous");
                    }
                    assertReady();
                    const result = execute();
                    assertSqliteWorkerCommitReceiptPending(fence.destination.database);
                    return result;
                  },
                  {
                    withCommit(commit) {
                      assertReady();
                      if (reservations.some(({ database }) => !database.isTransaction)) {
                        throw new SqliteWorkerError("SQLite source reservation was lost", "closed");
                      }
                      if (
                        Atomics.compareExchange(
                          decision,
                          0,
                          SOURCE_FENCE_READY,
                          SOURCE_FENCE_ACCEPTED,
                        ) !== SOURCE_FENCE_READY
                      ) {
                        throw new SqliteWorkerError(
                          "SQLite source fence commit was revoked",
                          "closed",
                        );
                      }
                      commit();
                    },
                  },
                );
              } finally {
                try {
                  rollbackReservations(reservations);
                } catch (error) {
                  // Destination COMMIT already owns its receipt even if source disposal fails.
                  cleanupFailure = { error };
                }
              }
            }),
          );
        } catch (error) {
          if (cleanupFailure) {
            throw new AggregateError(
              [error, cleanupFailure.error],
              "SQLite fence execution and cleanup failed",
              { cause: error },
            );
          }
          throw error;
        }
        if (cleanupFailure) {
          throw cleanupFailure.error;
        }
        return committedResult;
      });
    } catch (error) {
      if (entered || !isSqliteLockError(error)) {
        throw error;
      }
      assertReady();
      const remainingMs = Number(grant.deadlineNs - process.hrtime.bigint()) / 1_000_000;
      await sleep(Math.min(25, Math.max(0, remainingMs)));
    }
  }
}
