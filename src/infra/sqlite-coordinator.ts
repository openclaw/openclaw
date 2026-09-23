import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { isPathInside } from "./path-guards.js";
import { applyPrivateModeSync } from "./private-mode.js";
import { isSqliteLockError, withSqliteNativeOpen } from "./sqlite-error-diagnostics.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "./sqlite-handle-lifecycle.js";
import { sqliteWriteAdmissionServicesForLocation } from "./sqlite-transaction.js";

export const SqliteCoordinatorError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteCoordinatorError"),
  () =>
    class CoordinatorError extends Error {
      constructor(
        message: string,
        public override readonly cause?: unknown,
      ) {
        super(message);
        this.name = "SqliteCoordinatorError";
      }
    },
);
export type SqliteCoordinatorError = InstanceType<typeof SqliteCoordinatorError>;

export type SqliteCoordinatorFailureSettlement = {
  /** Every custody path whose scoped cleanup may retry this acquisition. */
  paths: readonly string[];
  settle: () => void;
};

type SqliteCoordinatorOptions = {
  busyTimeoutMs?: number;
  keepAlive?: boolean;
  /** Called only after a failed acquisition has no remaining native handle. */
  acquisitionFailure?: SqliteCoordinatorFailureSettlement;
};

export type SqliteCoordinatorLease = {
  /** This lease has relinquished custody, either to the pool or by native close. */
  readonly closed: boolean;
  release: (options?: { keepAlive?: false }) => void;
};

export function createSqliteLifecycleAggregateError(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}

/** Keep the first failure as the cause while retaining independent cleanup errors. */
export function throwSqliteLifecycleErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, message, errors[0]);
  }
}

export function runWithSqliteCoordinator<T>(
  coordinator: { release: () => void },
  operationLabel: string,
  operation: () => T,
): T {
  let result: T;
  try {
    result = operation();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new SqliteCoordinatorError(`${operationLabel} must remain synchronous`);
    }
  } catch (operationError) {
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      coordinator.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (releaseFailed) {
      throw createSqliteLifecycleAggregateError(
        [operationError, releaseError],
        `${operationLabel} and coordinator release both failed`,
        operationError,
      );
    }
    throw operationError;
  }
  try {
    coordinator.release();
  } catch (releaseError) {
    throw new SqliteCoordinatorError(
      `${operationLabel} completed, but releasing its coordinator failed`,
      releaseError,
    );
  }
  return result;
}

export function ensurePrivateSqliteCoordinatorDirectory(
  directoryPath: string,
  coordinatorLabel: string,
): void {
  try {
    fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const stats = fs.lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SqliteCoordinatorError(`${coordinatorLabel} directory must be a real directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new SqliteCoordinatorError(`${coordinatorLabel} directory belongs to another user`);
  }
  if (process.platform !== "win32") {
    if ((stats.mode & 0o7777) !== 0o700) {
      applyPrivateModeSync(directoryPath, 0o700);
    }
    const secured = fs.lstatSync(directoryPath);
    if (secured.isSymbolicLink() || !secured.isDirectory() || (secured.mode & 0o077) !== 0) {
      throw new SqliteCoordinatorError(`${coordinatorLabel} directory permissions are not private`);
    }
  }
}

type IdleCoordinator = {
  database: DatabaseSync;
  identity: fs.BigIntStats;
  timer: ReturnType<typeof setTimeout>;
};
// Bootstrap imports this owner before turns. Idle timers must not retain the
// request context that released a coordinator.
const coordinatorPool = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteCoordinatorPool"),
  () => ({
    runInCoordinatorPoolContext: AsyncLocalStorage.snapshot(),
    idleCoordinators: new Map<string, IdleCoordinator>(),
    failedIdleCloses: new Map<DatabaseSync, string>(),
    failedAcquisitionSettlements: new Map<DatabaseSync, SqliteCoordinatorFailureSettlement>(),
    noHandleSettlements: new Map<() => void, SqliteCoordinatorFailureSettlement>(),
    exitCloseRegistered: false,
    closeOnExit: closeIdleCoordinatorsOnExit,
  }),
  () => closeIdleCoordinatorPool(),
  "close-only",
);
const {
  runInCoordinatorPoolContext,
  idleCoordinators,
  failedIdleCloses,
  failedAcquisitionSettlements,
  noHandleSettlements,
} = coordinatorPool;

function updateCoordinatorExitClose() {
  const needed =
    idleCoordinators.size > 0 || failedIdleCloses.size > 0 || noHandleSettlements.size > 0;
  if (needed && !coordinatorPool.exitCloseRegistered) {
    process.once("exit", coordinatorPool.closeOnExit);
  } else if (!needed && coordinatorPool.exitCloseRegistered) {
    process.removeListener("exit", coordinatorPool.closeOnExit);
  }
  coordinatorPool.exitCloseRegistered = needed;
}

/** Retain receipt custody when acquisition failed before any native handle opened. */
export function settleUnopenedSqliteCoordinator(
  settlement: SqliteCoordinatorFailureSettlement,
): void {
  const { settle } = settlement;
  noHandleSettlements.set(settle, settlement);
  try {
    settle();
    noHandleSettlements.delete(settle);
  } finally {
    updateCoordinatorExitClose();
  }
}

function takeIdleCoordinator(location: string) {
  const idle = idleCoordinators.get(location);
  if (idle) {
    idleCoordinators.delete(location);
    clearTimeout(idle.timer);
    updateCoordinatorExitClose();
  }
  return idle;
}

function closeIdleCoordinatorDatabase(database: DatabaseSync, location: string) {
  try {
    if (database.isOpen) {
      database.close();
    }
    if (!database.isOpen) {
      failedAcquisitionSettlements.get(database)?.settle();
      failedAcquisitionSettlements.delete(database);
    }
  } finally {
    if (database.isOpen || failedAcquisitionSettlements.has(database)) {
      failedIdleCloses.set(database, location);
    } else {
      failedIdleCloses.delete(database);
    }
    updateCoordinatorExitClose();
  }
}

function closeIdleCoordinatorsOnExit() {
  for (const settlement of noHandleSettlements.values()) {
    try {
      settleUnopenedSqliteCoordinator(settlement);
    } catch {
      // The exact failed publication remains owned until process exit.
    }
  }
  const databases = new Map(failedIdleCloses);
  for (const [location] of idleCoordinators) {
    const idle = takeIdleCoordinator(location);
    if (idle) {
      databases.set(idle.database, location);
    }
  }
  for (const [database, location] of databases) {
    try {
      closeIdleCoordinatorDatabase(database, location);
    } catch {
      // Process exit is the last cleanup opportunity for a failed native close.
    }
  }
}

function closeIdleCoordinatorPool(include?: (location: string) => boolean): void {
  const databases = new Map(
    [...failedIdleCloses].filter(
      ([database, location]) =>
        !include ||
        include(location) ||
        failedAcquisitionSettlements.get(database)?.paths.some(include),
    ),
  );
  for (const [location] of idleCoordinators) {
    if (include && !include(location)) {
      continue;
    }
    const idle = takeIdleCoordinator(location);
    if (idle) {
      databases.set(idle.database, location);
    }
  }
  const errors: unknown[] = [];
  for (const [database, location] of databases) {
    try {
      closeIdleCoordinatorDatabase(database, location);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const settlement of noHandleSettlements.values()) {
    if (include && !settlement.paths.some(include)) {
      continue;
    }
    try {
      settleUnopenedSqliteCoordinator(settlement);
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Idle SQLite coordinator cleanup failed");
}

/** Dispose a removed runtime's idle connections after its active owners have settled. */
export function closeIdleSqliteCoordinators(rootPath: string): void {
  const root = path.resolve(rootPath);
  closeIdleCoordinatorPool((location) => isPathInside(root, location));
}

function readCoordinatorIdentity(location: string): fs.BigIntStats | undefined {
  try {
    const identity = fs.lstatSync(location, { bigint: true });
    return identity.isFile() && identity.dev !== 0n && identity.ino !== 0n ? identity : undefined;
  } catch {
    // Reuse is optional; a fresh SQLite open owns normal path errors/creation.
    return undefined;
  }
}

function matchesCoordinatorIdentity(left: fs.BigIntStats, right: fs.BigIntStats | undefined) {
  return (
    right !== undefined &&
    sameFileIdentity(left, right) &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function retainIdleCoordinator(location: string, database: DatabaseSync, identity: fs.BigIntStats) {
  const previous = takeIdleCoordinator(location);
  if (previous) {
    closeIdleCoordinatorDatabase(previous.database, location);
  }
  const timer = runInCoordinatorPoolContext(() =>
    setTimeout(() => {
      if (idleCoordinators.get(location)?.timer !== timer) {
        return;
      }
      const idle = takeIdleCoordinator(location);
      if (!idle) {
        return;
      }
      try {
        closeIdleCoordinatorDatabase(idle.database, location);
      } catch (error) {
        process.emitWarning(
          new SqliteCoordinatorError("Idle SQLite coordinator close failed", error),
        );
      }
    }, SQLITE_IDLE_HANDLE_TTL_MS),
  );
  timer.unref();
  idleCoordinators.set(location, { database, identity, timer });
  updateCoordinatorExitClose();
  return true;
}

function tryAcquireSqliteCoordinator(
  location: string,
  mode: "shared" | "exclusive",
  options: SqliteCoordinatorOptions,
): SqliteCoordinatorLease | null {
  const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 0));
  const reusableLocation =
    location !== "" && location !== ":memory:" && !location.startsWith("file:")
      ? path.resolve(location)
      : undefined;
  const poolLocation =
    reusableLocation && (options.keepAlive || idleCoordinators.has(reusableLocation))
      ? reusableLocation
      : undefined;
  const before = poolLocation ? readCoordinatorIdentity(poolLocation) : undefined;
  const idle = poolLocation ? takeIdleCoordinator(poolLocation) : undefined;
  const reused = idle && matchesCoordinatorIdentity(idle.identity, before) ? idle : undefined;
  let database = reused?.database;
  let identity: fs.BigIntStats | undefined;
  try {
    if (poolLocation && idle && !reused) {
      closeIdleCoordinatorDatabase(idle.database, poolLocation);
    }
    database ??= withSqliteNativeOpen(() => openNodeSqliteDatabase(location));
    // Kysely transaction callbacks cannot own a lock beyond their synchronous commit section.
    // This handle never writes or commits data. Keep the empty database's initial
    // journal in memory so acquiring a lock does not create filesystem artifacts.
    const services =
      mode === "exclusive" ? sqliteWriteAdmissionServicesForLocation(location) : undefined;
    const deadline = performance.now() + busyTimeoutMs;
    for (;;) {
      const attemptTimeout = services
        ? Math.min(25, Math.max(0, Math.ceil(deadline - performance.now())))
        : busyTimeoutMs;
      try {
        database.exec(
          `PRAGMA busy_timeout = ${attemptTimeout}; PRAGMA journal_mode = MEMORY; ${
            mode === "exclusive"
              ? "BEGIN EXCLUSIVE;"
              : "BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1;"
          }`,
        );
        break;
      } catch (error) {
        if (!services || !isSqliteLockError(error) || performance.now() >= deadline) {
          throw error;
        }
        for (const service of services) {
          service();
        }
      }
    }
    if (poolLocation && before) {
      const current = readCoordinatorIdentity(poolLocation);
      if (matchesCoordinatorIdentity(before, current)) {
        identity = before;
      } else if (reused) {
        throw new SqliteCoordinatorError("SQLite coordinator changed during acquisition");
      }
    }
  } catch (error) {
    try {
      if (database) {
        if (options.acquisitionFailure) {
          failedAcquisitionSettlements.set(database, options.acquisitionFailure);
        }
        // Failed acquisition cannot return a lease. Keep its exact native owner
        // for closeIdleSqliteCoordinators/exit retry if close or settlement fails.
        closeIdleCoordinatorDatabase(database, poolLocation ?? reusableLocation ?? location);
      } else if (options.acquisitionFailure) {
        settleUnopenedSqliteCoordinator(options.acquisitionFailure);
      }
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite coordinator acquisition and cleanup both failed",
        error,
      );
    }
    if (isSqliteLockError(error)) {
      return null;
    }
    throw error;
  }
  let released = false;
  return {
    get closed() {
      return released || !database.isOpen;
    },
    release: (releaseOptions) => {
      if (released || !database.isOpen) {
        return;
      }
      const errors: unknown[] = [];
      if (database.isTransaction) {
        try {
          database.exec("ROLLBACK");
          if (poolLocation && database.isTransaction) {
            throw new SqliteCoordinatorError(
              "SQLite coordinator rollback left its transaction open",
            );
          }
        } catch (error) {
          errors.push(error);
        }
      }
      let retained = false;
      if (
        errors.length === 0 &&
        options.keepAlive &&
        releaseOptions?.keepAlive !== false &&
        poolLocation &&
        identity &&
        !failedIdleCloses.has(database)
      ) {
        try {
          retained = retainIdleCoordinator(poolLocation, database, identity);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!retained && database.isOpen) {
        try {
          if (poolLocation) {
            closeIdleCoordinatorDatabase(database, poolLocation);
          } else {
            database.close();
          }
        } catch (error) {
          errors.push(error);
        }
      }
      // Pool handoff ends this lease; a later borrower owns the still-open handle.
      released = retained || !database.isOpen;
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite coordinator rollback and close both failed");
      }
    },
  };
}

/** Hold a raw exclusive transaction until release for cross-process coordination. */
export function tryAcquireExclusiveSqliteCoordinator(
  location: string,
  options: SqliteCoordinatorOptions = {},
): SqliteCoordinatorLease | null {
  return tryAcquireSqliteCoordinator(location, "exclusive", options);
}

/** Retain a read lock for a live handle; no rows or journal files are written. */
export function tryAcquireSharedSqliteCoordinator(
  location: string,
  options: SqliteCoordinatorOptions = {},
): SqliteCoordinatorLease | null {
  return tryAcquireSqliteCoordinator(location, "shared", options);
}
