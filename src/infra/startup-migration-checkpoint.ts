// Serializes Doctor repair and current-state startup writes in shared state.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { reclaimDeadOpenClawStateLeaseInTransaction } from "../state/openclaw-state-lease-store.js";
import { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
import { VERSION } from "../version.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { sqlitePrimaryResultCode } from "./sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "./state-lease-process-owner.js";

type StartupMigrationCheckpointDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "schema_meta" | "state_leases"
>;

const STARTUP_MIGRATION_META_KEY = "startup-migrations";
const STATE_MIGRATION_META_KEY = "state-migrations";
// Retain the shipped lease scope/key so older and current processes serialize together.
const STARTUP_MIGRATION_LEASE_SCOPE = "startup-migrations";
const STARTUP_MIGRATION_LEASE_KEY = "global";
const STARTUP_MIGRATION_LEASE_POLL_INTERVAL_MS = 250;
export const STARTUP_MIGRATION_LEASE_TTL_MS = 5 * 60_000;
export const STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS = 60_000;

export type StartupMigrationLease = {
  assertOwnedInTransaction: (database: DatabaseSync, params?: { nowMs?: number }) => void;
  heartbeat: (params?: { nowMs?: number }) => void;
  release: () => void;
  readonly owner: string;
};

type StartupMigrationLeaseParams = {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  owner?: string;
  /** Process id that owns the startup migration work. */
  ownerPid?: number;
};

type StartupMigrationLeaseWaitParams = Omit<StartupMigrationLeaseParams, "nowMs"> & {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

class StartupMigrationLeaseConflictError extends Error {
  readonly canWaitForSameHostOwner: boolean;

  constructor(message: string, canWaitForSameHostOwner: boolean) {
    super(message);
    this.canWaitForSameHostOwner = canWaitForSameHostOwner;
  }
}

function withStartupMigrationCheckpointDatabase<T>(
  env: NodeJS.ProcessEnv,
  callback: (db: DatabaseSync) => T,
  atomic = false,
): T {
  return withOpenClawStateStartupMigrationCheckpointDatabase(callback, { env, atomic });
}

function writeStartupMigrationCheckpointDatabase<T>(
  env: NodeJS.ProcessEnv,
  callback: (db: DatabaseSync) => T,
): T {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  return withStartupMigrationCheckpointDatabase(env, (db) =>
    runSqliteImmediateTransactionSync(db, () => {
      assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
      return callback(db);
    }),
  );
}

function assertStartupMigrationLeaseOwnedInTransaction(params: {
  database: DatabaseSync;
  nowMs?: number;
  owner: string;
}): void {
  const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(params.database);
  const activeLease = executeSqliteQueryTakeFirstSync(
    params.database,
    stateDb
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
      .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
      .where("owner", "=", params.owner)
      .where("expires_at", ">", params.nowMs ?? Date.now()),
  );
  if (!activeLease) {
    throw new Error(
      "OpenClaw startup migration lease was lost before startup migrations completed; retry so migrations can run under a fresh lease.",
    );
  }
}

/** Returns whether the shared startup/Doctor lease has a live process owner. */
export function hasActiveStartupMigrationLease(
  params: {
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    onActivity?: (activity: { owner: string; pid?: number; heartbeatAt: number | null }) => void;
  } = {},
): boolean {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
        const lease = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("state_leases")
            .select(["payload_json as payloadJson", "owner", "heartbeat_at as heartbeatAt"])
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("expires_at", ">", nowMs),
        );
        if (!lease) {
          return false;
        }
        const owner = parseStateLeaseProcessOwner(lease.payloadJson);
        if (readStateLeaseProcessOwnerStatus(owner) === "dead") {
          return false;
        }
        params.onActivity?.({
          owner: lease.owner,
          pid: owner?.host === hostname() ? owner.pid : undefined,
          heartbeatAt: lease.heartbeatAt,
        });
        return true;
      },
      { env },
    ) ?? false
  );
}

function acquireStartupMigrationLease(
  params: StartupMigrationLeaseParams,
  now: () => number,
): StartupMigrationLease {
  const env = params.env ?? process.env;
  const owner = params.owner ?? randomUUID();
  return withStartupMigrationCheckpointDatabase(
    env,
    (db) =>
      // Integrity verification may outlast a lease; start its lifetime at the actual claim.
      acquireStartupMigrationLeaseFromDatabase(db, { ...params, env, nowMs: now(), owner }),
    true,
  );
}

function acquireStartupMigrationLeaseFromDatabase(
  connection: DatabaseSync,
  params: StartupMigrationLeaseParams,
): StartupMigrationLease {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const owner = params.owner ?? randomUUID();
  const ownerPid = params.ownerPid ?? process.pid;
  const leaseOwner: StateLeaseProcessOwner = {
    pid: ownerPid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(ownerPid),
  };
  const expiresAt = nowMs + STARTUP_MIGRATION_LEASE_TTL_MS;

  runSqliteImmediateTransactionSync(connection, () => {
    const db = connection;
    assertOpenClawStateWriteAllowed({
      database: db,
      databasePath: resolveOpenClawStateSqlitePath(env),
      env,
    });
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("state_leases")
        .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
        .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
        .where("expires_at", "<=", nowMs),
    );
    const existing = reclaimDeadOpenClawStateLeaseInTransaction(db, {
      scope: STARTUP_MIGRATION_LEASE_SCOPE,
      key: STARTUP_MIGRATION_LEASE_KEY,
    });
    const existingOwner = parseStateLeaseProcessOwner(existing?.payloadJson ?? null);
    if (existing) {
      const ownerHint = existingOwner ? ` (held by pid ${existingOwner.pid})` : "";
      throw new StartupMigrationLeaseConflictError(
        `OpenClaw startup migrations are already running for this state directory; retry after the other OpenClaw process finishes or after ${new Date(existing.expiresAt ?? expiresAt).toISOString()}.${ownerHint}`,
        existingOwner?.host === hostname(),
      );
    }
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("state_leases").values({
        scope: STARTUP_MIGRATION_LEASE_SCOPE,
        lease_key: STARTUP_MIGRATION_LEASE_KEY,
        owner,
        expires_at: expiresAt,
        heartbeat_at: nowMs,
        payload_json: JSON.stringify({ version: VERSION, owner: leaseOwner }),
        created_at: nowMs,
        updated_at: nowMs,
      }),
    );
  });

  return {
    owner,
    assertOwnedInTransaction: (database, assertionParams = {}) => {
      assertStartupMigrationLeaseOwnedInTransaction({
        database,
        owner,
        nowMs: assertionParams.nowMs,
      });
    },
    heartbeat: (heartbeatParams = {}) => {
      const heartbeatNowMs = heartbeatParams.nowMs ?? Date.now();
      const heartbeatExpiresAt = heartbeatNowMs + STARTUP_MIGRATION_LEASE_TTL_MS;
      writeStartupMigrationCheckpointDatabase(env, (db) => {
        const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
        const result = executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("state_leases")
            .set({
              expires_at: heartbeatExpiresAt,
              heartbeat_at: heartbeatNowMs,
              updated_at: heartbeatNowMs,
            })
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("owner", "=", owner)
            .where("expires_at", ">", heartbeatNowMs),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            "OpenClaw startup migration lease was lost before startup migrations completed; retry so migrations can run under a fresh lease.",
          );
        }
      });
    },
    release: () => {
      writeStartupMigrationCheckpointDatabase(env, (db) => {
        const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("state_leases")
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("owner", "=", owner),
        );
      });
    },
  };
}

export function acquireStartupMigrationLeaseWithWait(
  params: StartupMigrationLeaseWaitParams = {},
): Promise<StartupMigrationLease> {
  const now = params.now ?? Date.now;
  const monotonicNow = params.monotonicNow ?? performance.now.bind(performance);
  const timeoutMs = Math.max(
    0,
    Math.min(params.timeoutMs ?? STARTUP_MIGRATION_LEASE_TTL_MS, STARTUP_MIGRATION_LEASE_TTL_MS),
  );
  const pollIntervalMs = Math.max(
    1,
    params.pollIntervalMs ?? STARTUP_MIGRATION_LEASE_POLL_INTERVAL_MS,
  );
  const owner = params.owner ?? randomUUID();
  return acquireWithWait({
    deadlineMs: monotonicNow() + timeoutMs,
    pollIntervalMs,
    now: monotonicNow,
    sleep: params.sleep,
    acquire: () =>
      acquireStartupMigrationLease({ env: params.env, owner, ownerPid: params.ownerPid }, now),
    shouldRetry: (error) =>
      (error instanceof StartupMigrationLeaseConflictError && error.canWaitForSameHostOwner) ||
      sqlitePrimaryResultCode(error) === 5,
  });
}

/** Unfinished owner work cannot retain an earlier successful aggregate checkpoint. */
export function invalidateSuccessfulMigrationCheckpointsInTransaction(
  database: DatabaseSync,
): void {
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(database)
      .deleteFrom("schema_meta")
      .where("meta_key", "in", [STATE_MIGRATION_META_KEY, STARTUP_MIGRATION_META_KEY]),
  );
}
