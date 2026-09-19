// Coordinates automatic state-migration and gateway-startup checkpoints in shared state.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
const STARTUP_MIGRATION_BUILD_SEPARATOR = "\n";
const STARTUP_MIGRATION_CHECKPOINT_FORMAT = "3";
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

// Built-at provenance changes when mutable source is rebuilt even if package version and commit do
// not. Missing provenance deliberately keeps migrations enabled instead of trusting stale code.
function resolveStartupMigrationBuildIdentity(moduleUrl: string = import.meta.url): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of [
      "./build-info.json",
      "../build-info.json",
      "../../dist/build-info.json",
    ]) {
      try {
        const info = require(candidate) as { builtAt?: unknown };
        if (typeof info.builtAt !== "string" || !info.builtAt.trim()) {
          continue;
        }
        return info.builtAt.trim();
      } catch {
        // Try the next packaged/source-build location.
      }
    }
  } catch {
    // Missing build provenance disables the fast path below.
  }
  return null;
}

function withStartupMigrationCheckpointDatabase<T>(
  env: NodeJS.ProcessEnv,
  callback: (db: DatabaseSync) => T,
): T {
  return withOpenClawStateStartupMigrationCheckpointDatabase(callback, { env });
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

type MigrationCheckpointMetaKey =
  | typeof STARTUP_MIGRATION_META_KEY
  | typeof STATE_MIGRATION_META_KEY;

export type MigrationCheckpointIdentity = {
  effectiveConfigFingerprint: string;
  pluginDoctorConfigFingerprint: string;
  pluginMigrationFingerprint: string;
};

type MigrationCheckpointParams = {
  buildIdentity?: string | null;
  env?: NodeJS.ProcessEnv;
  identity?: MigrationCheckpointIdentity | null;
  version?: string;
};

type RecordMigrationCheckpointParams = MigrationCheckpointParams & {
  lease?: StartupMigrationLease;
  nowMs?: number;
};

function formatStartupMigrationCheckpoint(params: {
  buildIdentity: string | null;
  identity: MigrationCheckpointIdentity | null | undefined;
  version: string;
}): string | null {
  const identity = params.identity;
  if (
    params.buildIdentity === null ||
    !identity ||
    !identity.effectiveConfigFingerprint.trim() ||
    !identity.pluginDoctorConfigFingerprint.trim() ||
    !identity.pluginMigrationFingerprint.trim()
  ) {
    return null;
  }
  return [
    params.version,
    STARTUP_MIGRATION_CHECKPOINT_FORMAT,
    params.buildIdentity,
    identity.effectiveConfigFingerprint,
    identity.pluginDoctorConfigFingerprint,
    identity.pluginMigrationFingerprint,
  ].join(STARTUP_MIGRATION_BUILD_SEPARATOR);
}

function readMigrationCheckpoints(
  env: NodeJS.ProcessEnv,
  metaKeys: MigrationCheckpointMetaKey[],
): Array<{ metaKey: string; appVersion: string | null }> {
  return withStartupMigrationCheckpointDatabase(env, (db) => {
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    const result = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("schema_meta")
        .select(["meta_key as metaKey", "app_version as appVersion"])
        .where("meta_key", "in", metaKeys),
    );
    return result.rows;
  });
}

export function readStartupMigrationVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    readMigrationCheckpoints(env, [STARTUP_MIGRATION_META_KEY])[0]?.appVersion?.split(
      STARTUP_MIGRATION_BUILD_SEPARATOR,
      1,
    )[0] ?? null
  );
}

/** Returns whether the canonical automatic-migration lease is still live. */
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

export function readMigrationCheckpointStatus(
  params: MigrationCheckpointParams = {},
): "stale" | "state-current" | "startup-current" {
  const env = params.env ?? process.env;
  const buildIdentity =
    params.buildIdentity === undefined
      ? resolveStartupMigrationBuildIdentity()
      : params.buildIdentity;
  const checkpoint = formatStartupMigrationCheckpoint({
    buildIdentity,
    identity: params.identity,
    version: params.version ?? VERSION,
  });
  if (checkpoint === null) {
    return "stale";
  }
  // A legacy gateway checkpoint also proves state migrations completed. The inverse is false:
  // state-only commands never certify gateway plugin convergence.
  const current = readMigrationCheckpoints(env, [
    STATE_MIGRATION_META_KEY,
    STARTUP_MIGRATION_META_KEY,
  ]).filter((row) => row.appVersion === checkpoint);
  if (current.some((row) => row.metaKey === STARTUP_MIGRATION_META_KEY)) {
    return "startup-current";
  }
  return current.length > 0 ? "state-current" : "stale";
}

export function acquireStartupMigrationLease(
  params: StartupMigrationLeaseParams = {},
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

  writeStartupMigrationCheckpointDatabase(env, (db) => {
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

export async function acquireStartupMigrationLeaseWithWait(
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
      acquireStartupMigrationLease({
        env: params.env,
        nowMs: now(),
        owner,
        ownerPid: params.ownerPid,
      }),
    shouldRetry: (error) =>
      error instanceof StartupMigrationLeaseConflictError && error.canWaitForSameHostOwner,
  });
}

function recordSuccessfulMigrationCheckpoints(
  metaKeys: MigrationCheckpointMetaKey[],
  params: RecordMigrationCheckpointParams = {},
): void {
  const env = params.env ?? process.env;
  const version = params.version ?? VERSION;
  const buildIdentity =
    params.buildIdentity === undefined
      ? resolveStartupMigrationBuildIdentity()
      : params.buildIdentity;
  const nowMs = params.nowMs ?? Date.now();
  const checkpoint = formatStartupMigrationCheckpoint({
    buildIdentity,
    identity: params.identity,
    version,
  });
  if (checkpoint === null) {
    return;
  }
  writeStartupMigrationCheckpointDatabase(env, (db) => {
    params.lease?.assertOwnedInTransaction(db, { nowMs });
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    for (const metaKey of metaKeys) {
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("schema_meta")
          .values({
            meta_key: metaKey,
            role: "global",
            schema_version: 3,
            agent_id: null,
            app_version: checkpoint,
            created_at: nowMs,
            updated_at: nowMs,
          })
          .onConflict((conflict) =>
            conflict.column("meta_key").doUpdateSet({
              role: "global",
              schema_version: 3,
              agent_id: null,
              app_version: checkpoint,
              updated_at: nowMs,
            }),
          ),
      );
    }
  });
}

export function recordSuccessfulStateMigrations(
  params: RecordMigrationCheckpointParams = {},
): void {
  recordSuccessfulMigrationCheckpoints([STATE_MIGRATION_META_KEY], params);
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

export function recordSuccessfulStartupMigrations(
  params: RecordMigrationCheckpointParams = {},
): void {
  recordSuccessfulMigrationCheckpoints(
    [STATE_MIGRATION_META_KEY, STARTUP_MIGRATION_META_KEY],
    params,
  );
}
