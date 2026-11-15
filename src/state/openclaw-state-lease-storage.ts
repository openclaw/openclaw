import { setTimeout as sleep } from "node:timers/promises";
import { computeBackoff } from "../infra/backoff.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { isStateDatabaseMaintenanceContention } from "../infra/gateway-state-owner-record.js";
import { captureStateDatabaseAccess } from "../infra/gateway-state-owner.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { prepareSqliteDatabaseScopedWriteRevisionForPath } from "../infra/sqlite-database-admission.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import type { SqliteTransactionOptions } from "../infra/sqlite-transaction.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { retainOpenClawStateDatabaseForIdle } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import {
  createOpenClawStateLeaseLostError,
  toOpenClawStateLeaseVerificationError,
} from "./openclaw-state-lease-error.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  LEASE_CONTENTION_RETRY_TIMEOUT_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  readOpenClawStateLeaseExpiry,
  readOpenClawStateLeaseLoss,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
  stateLeaseWriteScope,
} from "./openclaw-state-lease-store.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-maintenance-context.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type OpenClawStateLeaseNativeSource = {
  context: OpenClawStateWorkerContext;
  identity: DatabasePathIdentity;
  database?: OpenClawStateDatabase;
};

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
    ? resolveDatabasePath(database.options)
    : openOpenClawStateDatabase(database.options).path;
}
function readLeaseDatabase<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: EngineConnection) => T,
): T {
  return database.schemaPolicy === "existing"
    ? withOpenClawStateDatabaseReadOnly(({ db }) => operation(db), database.options)
    : operation(openOpenClawStateDatabase(database.options).db);
}

export function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: EngineConnection) => T,
  busyTimeoutMs = 0,
  singleStatement?: true,
): T {
  const transactionOptions = {
    operationLabel,
    busyTimeoutMs,
    beginLockFailureReporting: busyTimeoutMs === 0 ? "suppress" : undefined,
  } satisfies SqliteTransactionOptions;
  if (database.schemaPolicy === "existing") {
    return runExistingOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      database.options ?? {},
      { ...transactionOptions, schemaSql: leaseSchema },
    );
  }
  // Native renewal and release are lock primitives; their callers remain outside admission.
  return withEngineStoreAdmission(() => {
    const stateDatabase = database.options?.database ?? openOpenClawStateDatabase(database.options);
    return runOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      { ...database.options, database: stateDatabase },
      {
        ...transactionOptions,
        singleStatement:
          singleStatement && !isPostgresSqlConnection(stateDatabase.db) ? true : undefined,
      },
    );
  });
}

export const STATE_LEASE_WRITE_BACKOFF = {
  initialMs: LEASE_CONTENTION_RETRY_MS,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;

export type OpenClawStateLeaseOwnerIdentity = OpenClawStateLeaseIdentity &
  Parameters<typeof createOpenClawStateLeaseLostError>[0] & { leaseLabel: string };

export function createOpenClawStateLeaseLostErrorFromDatabase(
  identity: OpenClawStateLeaseOwnerIdentity,
  database: OpenClawStateLeaseDatabase,
  cause?: unknown,
) {
  let loss;
  try {
    loss = readLeaseDatabase(database, (db) => readOpenClawStateLeaseLoss(db, identity));
  } catch {
    // Expiry still fences the owner if storage or admission is unavailable.
  }
  return createOpenClawStateLeaseLostError(identity, cause, loss);
}

export function renewOpenClawStateLease(
  params: OpenClawStateLeaseOwnerIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number {
  return withLeaseWriteTransaction(
    params.database,
    params.operationLabel === "state.lease" ? "state.lease.renew" : params.operationLabel,
    (db) => {
      const expiresAt = renewOpenClawStateLeaseInTransaction(db, params, params.leaseMs);
      if (expiresAt === undefined) {
        throw createOpenClawStateLeaseLostError(
          params,
          undefined,
          readOpenClawStateLeaseLoss(db, params),
        );
      }
      return expiresAt;
    },
  );
}

export function renewOpenClawStateLeaseForHandoff(
  params: Parameters<typeof renewOpenClawStateLease>[0],
): number {
  try {
    return renewOpenClawStateLease(params);
  } catch (error) {
    if (!isSqliteLockError(error)) {
      throw error;
    }
    return verifyOpenClawStateLeaseOwnership(params);
  }
}

function assertOpenClawStateLeaseOwnedInDatabase(
  database: EngineConnection,
  params: OpenClawStateLeaseOwnerIdentity,
): number {
  const expiresAt = readOpenClawStateLeaseExpiry(database, params);
  if (expiresAt === undefined) {
    throw createOpenClawStateLeaseLostError(
      params,
      undefined,
      readOpenClawStateLeaseLoss(database, params),
    );
  }
  return expiresAt;
}

export function verifyOpenClawStateLeaseOwnership(
  params: OpenClawStateLeaseOwnerIdentity & {
    database?: OpenClawStateLeaseDatabase;
    transaction?: EngineConnection;
  },
): number {
  try {
    if (params.transaction) {
      return assertOpenClawStateLeaseOwnedInDatabase(params.transaction, params);
    }
    const database = params.database;
    if (!database) {
      throw new Error("state lease ownership check requires a database");
    }
    const read = () =>
      readLeaseDatabase(database, (db) => assertOpenClawStateLeaseOwnedInDatabase(db, params));
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (isStatePostgres() && maintenance?.ownsSchemaMaintenance) {
      // Doctor's synchronous lease check remains inside its admitted maintenance lifetime.
      maintenance.assertAdmission();
    }
    // Admit only the synchronous lease check; protected operations retain their own SQL boundary.
    return withEngineStoreAdmission(read);
  } catch (error) {
    throw toOpenClawStateLeaseVerificationError(params, error);
  }
}

/** Only a live Gateway's retained handle can reuse its complete in-process writer epochs. */
export async function prepareOpenClawStateLeaseVerification(
  native: OpenClawStateLeaseNativeSource | undefined,
  identity: OpenClawStateLeaseOwnerIdentity,
) {
  const opened = native?.database;
  // Existing-schema acquisition has no retained handle; maintenance keeps durable checks.
  if (!native || !opened || native.context.maintenanceScope || isPostgresSqlConnection(opened.db)) {
    return undefined;
  }
  const database = opened.db;
  const releaseIdle = retainOpenClawStateDatabaseForIdle(opened);
  let retained = false;
  try {
    const source = native.context;
    const access = await captureStateDatabaseAccess(source.admission.databasePath);
    const owner = access.processOwner;
    if (owner?.role !== "gateway") {
      return undefined;
    }
    const assertAccess = await access.prepareAccess();
    const revision = prepareSqliteDatabaseScopedWriteRevisionForPath(
      source.admission.databasePath,
      [stateLeaseWriteScope(identity)],
    );
    if (!revision) {
      return undefined;
    }
    let epoch: number | undefined;
    let expiresAt = 0;
    retained = true;
    return {
      verify() {
        source.admission.assertCurrent();
        owner.assertCurrent();
        assertAccess();
        const before = !database.isOpen || database.isTransaction ? undefined : revision.read();
        // Read the epoch before expiry: a settled renewal can extend this same grant.
        if (before !== undefined && before === epoch && Date.now() < expiresAt) {
          return;
        }
        epoch = undefined;
        const verifiedExpiry = verifyOpenClawStateLeaseOwnership({
          ...identity,
          transaction: database,
        });
        if (before !== undefined && before === revision.read()) {
          epoch = before;
          expiresAt = verifiedExpiry;
        }
      },
      release() {
        try {
          revision.release();
        } finally {
          releaseIdle();
        }
      },
    };
  } finally {
    if (!retained) {
      releaseIdle();
    }
  }
}

export function releaseOpenClawStateLease(
  params: OpenClawStateLeaseOwnerIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
  },
): void {
  withLeaseWriteTransaction(
    params.database,
    params.operationLabel === "state.lease" ? "state.lease.release" : params.operationLabel,
    (db) => releaseOpenClawStateLeaseInTransaction(db, params),
    0,
    true,
  );
}

export async function releaseOpenClawStateLeaseBestEffort(
  params: Parameters<typeof releaseOpenClawStateLease>[0],
  execute?: () => Promise<void>,
): Promise<void> {
  const deadline = performance.now() + LEASE_CONTENTION_RETRY_TIMEOUT_MS;
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
      if (
        (!isSqliteLockError(error) && !isStateDatabaseMaintenanceContention(error)) ||
        now >= deadline
      ) {
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
