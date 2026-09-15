import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  OpenClawStateLeaseError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLeaseExpiry,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export const STATE_LEASE_WRITE_BACKOFF = {
  initialMs: 25,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;
const RELEASE_RETRY_TIMEOUT_MS = 2_000;

// A competing lifecycle writer has not admitted the transaction. Retry within
// the existing async budget, but never retry schema, handle, or release failures.
export function isOpenClawStateLeaseWriteContention(error: unknown): boolean {
  return (
    isSqliteLockError(error) ||
    (error instanceof StateDatabaseCoordinatorContentionError && error.family === "state-lifecycle")
  );
}

export type OpenClawStateLeaseDatabase = {
  scope: "shared";
  options?: OpenClawStateDatabaseOptions;
  /** Storage compatibility only, never authority. Acquisition still claims the real lease. */
  schemaPolicy?: "existing";
};
const leaseSchema = ["schema_meta", "state_leases"]
  .map((table) => {
    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const marker = ") STRICT;";
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
    if (start < 0 || end < 0) {
      throw new Error("Existing lease schema is unavailable.");
    }
    return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length);
  })
  .join("\n");

export function resolveLeaseDatabasePath(database: OpenClawStateLeaseDatabase): string {
  return database.schemaPolicy === "existing"
    ? path.resolve(database.options?.path ?? resolveOpenClawStateSqlitePath(database.options?.env))
    : openOpenClawStateDatabase(database.options).path;
}
export function readLeaseDatabase<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: DatabaseSync) => T,
): T {
  return database.schemaPolicy === "existing"
    ? withOpenClawStateDatabaseReadOnly(({ db }) => operation(db), database.options)
    : operation(openOpenClawStateDatabase(database.options).db);
}
function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
  busyTimeoutMs = 0,
): T {
  if (database.schemaPolicy === "existing") {
    return runExistingOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      database.options ?? {},
      { operationLabel, busyTimeoutMs, schemaSql: leaseSchema },
    );
  }
  const stateDatabase = openOpenClawStateDatabase(database.options);
  const run = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      { ...database.options, database: stateDatabase },
      { operationLabel, busyTimeoutMs },
    );
  return runWithSqliteBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
}

export type OpenClawStateLeaseOwnerIdentity = {
  scope: string;
  key: string;
  owner: string;
  leaseLabel: string;
};

export function tryAcquireOpenClawStateLease(
  params: OpenClawStateLeaseOwnerIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number | undefined {
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db) =>
    acquireOpenClawStateLeaseInTransaction(db, params, params.leaseMs),
  );
}

export function renewOpenClawStateLease(
  params: OpenClawStateLeaseOwnerIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number {
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db) => {
    const expiresAt = renewOpenClawStateLeaseInTransaction(db, params, params.leaseMs);
    if (expiresAt === undefined) {
      throw new OpenClawStateLeaseError(
        `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
        {
          code: "OPENCLAW_STATE_LEASE_LOST",
        },
      );
    }
    return expiresAt;
  });
}

export function assertOpenClawStateLeaseOwnedInDatabase(
  database: DatabaseSync,
  params: OpenClawStateLeaseOwnerIdentity,
): number {
  const expiresAt = readOpenClawStateLeaseExpiry(database, params);
  if (expiresAt === undefined) {
    throw new OpenClawStateLeaseError(
      `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
      {
        code: "OPENCLAW_STATE_LEASE_LOST",
      },
    );
  }
  return expiresAt;
}

export function verifyOpenClawStateLeaseOwnership(
  params: OpenClawStateLeaseOwnerIdentity & {
    database?: OpenClawStateLeaseDatabase;
    transaction?: DatabaseSync;
  },
): number {
  try {
    if (params.transaction) {
      return assertOpenClawStateLeaseOwnedInDatabase(params.transaction, params);
    }
    if (!params.database) {
      throw new Error("state lease ownership check requires a database");
    }
    return readLeaseDatabase(params.database, (db) =>
      assertOpenClawStateLeaseOwnedInDatabase(db, params),
    );
  } catch (error) {
    throw toOpenClawStateLeaseVerificationError(params, error);
  }
}

export function releaseOpenClawStateLease(
  params: OpenClawStateLeaseOwnerIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
  },
): void {
  withLeaseWriteTransaction(params.database, params.operationLabel, (db) =>
    releaseOpenClawStateLeaseInTransaction(db, params),
  );
}

export async function releaseOpenClawStateLeaseBestEffort(
  params: Parameters<typeof releaseOpenClawStateLease>[0],
  execute?: () => Promise<void>,
): Promise<void> {
  const deadline = performance.now() + RELEASE_RETRY_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    try {
      if (execute) {
        await execute();
      } else {
        releaseOpenClawStateLease(params);
      }
      return;
    } catch (error) {
      const now = performance.now();
      if (!isOpenClawStateLeaseWriteContention(error) || now >= deadline) {
        return;
      }
      attempt += 1;
      // Cleanup gives competing writers a bounded async window to finish.
      await sleepWithAbort(
        Math.min(deadline - now, computeBackoff(STATE_LEASE_WRITE_BACKOFF, attempt)),
      );
    }
  }
}
