import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { computeBackoff } from "../infra/backoff.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  createOpenClawStateLeaseLostError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import {
  readOpenClawStateLeaseExpiry,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export type OpenClawStateLeaseDatabase = {
  scope: "shared";
  options?: OpenClawStateDatabaseOptions;
  /** Storage compatibility only, never authority. Acquisition still claims the real lease. */
  schemaPolicy?: "existing";
};
const leaseSchema = ["schema_meta", "state_leases"]
  .map((table) =>
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
      endMarker: ") STRICT;",
      errorMessage: "Existing lease schema is unavailable.",
    }),
  )
  .join("\n");

export function prepareLeaseDatabase(database: OpenClawStateLeaseDatabase): void {
  if (database.schemaPolicy !== "existing") {
    runWithOpenClawStateBusyTimeout(() => undefined, database.options ?? {}, 0);
  }
}

export function resolveLeaseDatabasePath(database: OpenClawStateLeaseDatabase): string {
  return database.schemaPolicy === "existing"
    ? path.resolve(database.options?.path ?? resolveOpenClawStateSqlitePath(database.options?.env))
    : openOpenClawStateDatabase(database.options).path;
}
function readLeaseDatabase<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: DatabaseSync) => T,
): T {
  return database.schemaPolicy === "existing"
    ? withOpenClawStateDatabaseReadOnly(({ db }) => operation(db), database.options)
    : operation(openOpenClawStateDatabase(database.options).db);
}

export function withLeaseWriteTransaction<T>(
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

export const STATE_LEASE_WRITE_BACKOFF = {
  initialMs: 25,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;
const RELEASE_RETRY_TIMEOUT_MS = 2_000;

export type OpenClawStateLeaseOwnerIdentity = OpenClawStateLeaseIdentity & { leaseLabel: string };

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
      throw createOpenClawStateLeaseLostError(params);
    }
    return expiresAt;
  });
}

function assertOpenClawStateLeaseOwnedInDatabase(
  database: DatabaseSync,
  params: OpenClawStateLeaseOwnerIdentity,
): number {
  const expiresAt = readOpenClawStateLeaseExpiry(database, params);
  if (expiresAt === undefined) {
    throw createOpenClawStateLeaseLostError(params);
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
      if (!isSqliteLockError(error) || now >= deadline) {
        if (execute) {
          // The async resource owner retains failed cleanup for exact-owner retry.
          throw error;
        }
        return;
      }
      attempt += 1;
      // Cleanup outlives caller scheduling; native timers let competing writers settle.
      await sleep(Math.min(deadline - now, computeBackoff(STATE_LEASE_WRITE_BACKOFF, attempt)));
    }
  }
}
