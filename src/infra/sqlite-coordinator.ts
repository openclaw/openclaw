import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { applyPrivateModeSync } from "./private-mode.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";

export class SqliteCoordinatorError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SqliteCoordinatorError";
  }
}

export function createSqliteLifecycleAggregateError(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
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

const IDLE_COORDINATOR_TIMEOUT_MS = 30 * 60_000;
const MAX_IDLE_COORDINATORS = 16;
// Bootstrap imports this owner before turns. Idle timers must not retain the
// request context that released a coordinator.
const runInCoordinatorPoolContext = AsyncLocalStorage.snapshot();
type IdleCoordinator = {
  database: DatabaseSync;
  identity: fs.BigIntStats;
  timer: ReturnType<typeof setTimeout>;
};
const idleCoordinators = new Map<string, IdleCoordinator>();
const failedIdleCloses = new Set<DatabaseSync>();
let exitCloseRegistered = false;

function updateCoordinatorExitClose() {
  const needed = idleCoordinators.size > 0 || failedIdleCloses.size > 0;
  if (needed && !exitCloseRegistered) {
    process.once("exit", closeIdleCoordinatorsOnExit);
  } else if (!needed && exitCloseRegistered) {
    process.removeListener("exit", closeIdleCoordinatorsOnExit);
  }
  exitCloseRegistered = needed;
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

function closeIdleCoordinatorDatabase(database: DatabaseSync) {
  try {
    if (database.isOpen) {
      database.close();
    }
  } finally {
    if (database.isOpen) {
      failedIdleCloses.add(database);
    } else {
      failedIdleCloses.delete(database);
    }
    updateCoordinatorExitClose();
  }
}

function closeIdleCoordinatorsOnExit() {
  const databases = new Set(failedIdleCloses);
  for (const [location] of idleCoordinators) {
    const idle = takeIdleCoordinator(location);
    if (idle) {
      databases.add(idle.database);
    }
  }
  for (const database of databases) {
    try {
      closeIdleCoordinatorDatabase(database);
    } catch {
      // Process exit is the last cleanup opportunity for a failed native close.
    }
  }
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
    closeIdleCoordinatorDatabase(previous.database);
  }
  if (idleCoordinators.size + failedIdleCloses.size >= MAX_IDLE_COORDINATORS) {
    const oldest = idleCoordinators.keys().next().value;
    if (oldest !== undefined) {
      const evicted = takeIdleCoordinator(oldest);
      if (evicted) {
        closeIdleCoordinatorDatabase(evicted.database);
      }
    }
  }
  if (idleCoordinators.size + failedIdleCloses.size >= MAX_IDLE_COORDINATORS) {
    return false;
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
        closeIdleCoordinatorDatabase(idle.database);
      } catch (error) {
        process.emitWarning(
          new SqliteCoordinatorError("Idle SQLite coordinator close failed", error),
        );
      }
    }, IDLE_COORDINATOR_TIMEOUT_MS),
  );
  timer.unref();
  idleCoordinators.set(location, { database, identity, timer });
  updateCoordinatorExitClose();
  return true;
}

function tryAcquireSqliteCoordinator(
  location: string,
  mode: "shared" | "exclusive",
  options: { busyTimeoutMs?: number; keepAlive?: boolean },
): { release: (options?: { keepAlive?: false }) => void } | null {
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
  if (idle && !reused) {
    closeIdleCoordinatorDatabase(idle.database);
  }
  const database = reused?.database ?? openNodeSqliteDatabase(location);
  let identity: fs.BigIntStats | undefined;
  try {
    // Kysely transaction callbacks cannot own a lock beyond their synchronous commit section.
    // This handle never writes or commits data. Keep the empty database's initial
    // journal in memory so acquiring a lock does not create filesystem artifacts.
    database.exec(
      `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = MEMORY; ${
        mode === "exclusive"
          ? "BEGIN EXCLUSIVE;"
          : "BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1;"
      }`,
    );
    if (poolLocation && before) {
      const current = readCoordinatorIdentity(poolLocation);
      if (matchesCoordinatorIdentity(before, current)) {
        identity = before;
      } else if (reused) {
        throw new SqliteCoordinatorError("SQLite coordinator changed during acquisition");
      }
    }
  } catch (error) {
    if (poolLocation) {
      closeIdleCoordinatorDatabase(database);
    } else {
      database.close();
    }
    if (isSqliteLockError(error)) {
      return null;
    }
    throw error;
  }
  let released = false;
  return {
    release: (releaseOptions) => {
      if (released) {
        return;
      }
      released = true;
      const errors: unknown[] = [];
      try {
        database.exec("ROLLBACK");
        if (poolLocation && database.isTransaction) {
          throw new SqliteCoordinatorError("SQLite coordinator rollback left its transaction open");
        }
      } catch (error) {
        errors.push(error);
      }
      let retained = false;
      if (
        errors.length === 0 &&
        options.keepAlive &&
        releaseOptions?.keepAlive !== false &&
        poolLocation &&
        identity
      ) {
        try {
          retained = retainIdleCoordinator(poolLocation, database, identity);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!retained) {
        try {
          if (poolLocation) {
            closeIdleCoordinatorDatabase(database);
          } else {
            database.close();
          }
        } catch (error) {
          errors.push(error);
        }
      }
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
  options: { busyTimeoutMs?: number; keepAlive?: boolean } = {},
): { release: (options?: { keepAlive?: false }) => void } | null {
  return tryAcquireSqliteCoordinator(location, "exclusive", options);
}

/** Retain a read lock for a live handle; no rows or journal files are written. */
export function tryAcquireSharedSqliteCoordinator(
  location: string,
  options: { busyTimeoutMs?: number } = {},
): { release: () => void } | null {
  return tryAcquireSqliteCoordinator(location, "shared", options);
}
