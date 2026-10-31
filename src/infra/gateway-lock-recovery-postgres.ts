import { createHash } from "node:crypto";
import type { Client } from "pg";
import { stateEngineInput, stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { readEngineAnchorIdentity } from "./database-engine/physical-store.js";
import {
  readPostgresStoreMetadata,
  withPostgresConnection,
} from "./database-engine/postgres-store-metadata.js";
import type { RecoveryLease } from "./gateway-lock-recovery-lease.js";
import { assertGatewayRecoveryLeaseNotLive } from "./gateway-lock-recovery-lease.js";
import {
  assertGatewayOwnerLeaseColumns,
  decodeGatewayOwnerLease,
  GATEWAY_OWNER_LEASE_COLUMNS_SQL,
} from "./gateway-owner-lease.read.js";
import type { StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { quoteSqliteIdentifier as quote } from "./sqlite-schema-sql.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "./sqlite-worker-identity.js";

type PostgresAnchor = { engine: "postgres"; storeId: string; namespace: string };
export type PostgresGatewayRecovery = {
  anchor: PostgresAnchor;
  identity: DatabasePathIdentity;
  connection: string;
  version: number;
  raw: string | null;
  lease: RecoveryLease | null;
};

/** Lease inspection can outlive an application schema; destructive recovery cannot. */
export function assertPostgresGatewayRecoveryMutationSupported(
  recovery: PostgresGatewayRecovery,
): void {
  if (recovery.version !== stateEngineSchema.version) {
    throw new Error(
      `PostgreSQL GLOBAL schema version ${recovery.version} is not supported for Gateway lock recovery by this binary (expected ${stateEngineSchema.version}); use the matching OpenClaw version.`,
    );
  }
}

function selectedPostgres() {
  const input = stateEngineInput();
  if (!input) {
    throw new Error("PostgreSQL Gateway recovery selection changed");
  }
  return { input, connection: createHash("sha256").update(input.connection).digest("hex") };
}

function leaseTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("PostgreSQL Gateway owner lease has an invalid timestamp");
  }
  return Number(value);
}

async function readLease(client: Client, anchor: PostgresAnchor, lock = false) {
  const { rows } = await client.query<{
    raw: string;
    owner: string;
    created_at: string;
    expires_at: string | null;
    heartbeat_at: string | null;
    payload_json: string | null;
  }>(`SELECT row_to_json(lease)::text AS raw, owner, created_at::text,
      expires_at::text, heartbeat_at::text, payload_json
    FROM ${quote(anchor.namespace)}.state_leases AS lease
    WHERE scope = 'gateway-owner' AND lease_key = 'global'${lock ? " FOR UPDATE" : ""}`);
  if (rows.length > 1) {
    throw new Error("PostgreSQL Gateway owner lease is ambiguous");
  }
  const row = rows[0];
  if (!row) {
    return { raw: null, lease: null };
  }
  const lease: RecoveryLease = {
    owner: row.owner,
    createdAt: leaseTimestamp(row.created_at),
    expiresAt: row.expires_at === null ? null : leaseTimestamp(row.expires_at),
    heartbeatAt: row.heartbeat_at === null ? null : leaseTimestamp(row.heartbeat_at),
    payloadJson: row.payload_json,
  };
  if (
    typeof row.owner !== "string" ||
    !row.owner ||
    typeof row.raw !== "string" ||
    !decodeGatewayOwnerLease(lease)
  ) {
    throw new Error("PostgreSQL Gateway owner lease could not be verified");
  }
  return { raw: row.raw, lease };
}

async function stateVersion(client: Client, anchor: PostgresAnchor) {
  const metadata = await readPostgresStoreMetadata(client, anchor);
  if (metadata.store !== "state" || metadata.version < 1) {
    throw new Error("PostgreSQL Gateway recovery requires a verified state store");
  }
  assertGatewayOwnerLeaseColumns(
    (await client.query(GATEWAY_OWNER_LEASE_COLUMNS_SQL, [anchor.namespace])).rows,
  );
  return metadata.version;
}

async function transaction<T>(
  client: Client,
  readOnly: boolean,
  run: () => Promise<T>,
  beforeCommit?: () => void,
): Promise<T> {
  await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await run();
    beforeCommit?.();
    const completed = await client.query(readOnly ? "ROLLBACK" : "COMMIT");
    if (!readOnly && completed.command !== "COMMIT") {
      throw new Error("PostgreSQL Gateway recovery transaction did not commit");
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollback) {
      throw new AggregateError([error, rollback], "PostgreSQL Gateway recovery rollback failed", {
        cause: rollback,
      });
    }
    throw error;
  }
}

export async function inspectPostgresGatewayRecovery(
  databasePath: string,
): Promise<PostgresGatewayRecovery> {
  const { input, connection } = selectedPostgres();
  const identity = readDatabasePathIdentitySync(databasePath);
  const snapshot = await prepareSqliteReadOnlyLocation(databasePath, {
    allowLiveOwner: true,
    preserveSourceArtifacts: true,
    requireCleanup: true,
  });
  const cleanup = async (cause?: unknown) => {
    if (!(await snapshot.cleanupAsync())) {
      const error = new Error(
        "PostgreSQL Gateway recovery anchor inspection cleanup did not finish",
      );
      if (cause !== undefined) {
        throw new AggregateError([cause, error], error.message, { cause });
      }
      throw error;
    }
  };
  let inspected: PostgresGatewayRecovery;
  try {
    using db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    const anchor = readEngineAnchorIdentity(db, databasePath);
    if (anchor.engine !== "postgres") {
      throw new Error("PostgreSQL Gateway recovery requires its original anchor");
    }
    const result = await withPostgresConnection(
      input,
      (client) =>
        transaction(client, true, async () => ({
          version: await stateVersion(client, anchor),
          ...(await readLease(client, anchor)),
        })),
      { connectionTimeoutMillis: 10_000, query_timeout: 10_000 },
    );
    if (
      JSON.stringify(readDatabasePathIdentitySync(databasePath)) !== JSON.stringify(identity) ||
      selectedPostgres().connection !== connection
    ) {
      throw new Error("PostgreSQL Gateway recovery anchor or selection changed during inspection");
    }
    inspected = { anchor, identity, connection, ...result };
  } catch (error) {
    await cleanup(error);
    throw error;
  }
  await cleanup();
  return inspected;
}

export async function recoverPostgresGatewayLease(
  databasePath: string,
  expected: PostgresGatewayRecovery,
  custody: StateDatabaseSchemaLease,
): Promise<void> {
  const assertCurrent = () =>
    custody.run(() => {
      custody.assertDatabaseAccess(databasePath);
      if (
        selectedPostgres().connection !== expected.connection ||
        JSON.stringify(readDatabasePathIdentitySync(databasePath)) !==
          JSON.stringify(expected.identity)
      ) {
        throw new Error("PostgreSQL Gateway recovery anchor or selection changed");
      }
      using db = openNodeSqliteDatabase(databasePath, {
        readOnly: true,
      });
      if (
        JSON.stringify(readEngineAnchorIdentity(db, databasePath)) !==
        JSON.stringify(expected.anchor)
      ) {
        throw new Error("PostgreSQL Gateway recovery anchor changed");
      }
    });
  assertCurrent();
  const { input } = selectedPostgres();
  await withPostgresConnection(
    input,
    (client) =>
      transaction(
        client,
        false,
        async () => {
          assertCurrent();
          const key = createHash("sha256")
            .update(expected.anchor.storeId)
            .digest()
            .readBigInt64BE()
            .toString();
          const lock = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
            [key],
          );
          assertCurrent();
          if (lock.rows[0]?.acquired !== true) {
            throw new Error(
              "PostgreSQL Gateway recovery store is busy; inspect again after its operation settles",
            );
          }
          if ((await stateVersion(client, expected.anchor)) !== expected.version) {
            throw new Error("PostgreSQL Gateway recovery state metadata changed");
          }
          assertCurrent();
          const current = await readLease(client, expected.anchor, true);
          assertCurrent();
          if (current.raw !== expected.raw) {
            throw new Error("PostgreSQL Gateway owner lease changed; inspect the lock again");
          }
          assertGatewayRecoveryLeaseNotLive(current.lease);
          if (current.lease) {
            const removed = await client.query(
              `DELETE FROM ${quote(expected.anchor.namespace)}.state_leases AS lease
        WHERE scope = 'gateway-owner' AND lease_key = 'global' AND owner = $1 AND row_to_json(lease)::text = $2`,
              [current.lease.owner, current.raw],
            );
            if (removed.rowCount !== 1) {
              throw new Error("PostgreSQL Gateway owner lease changed before recovery");
            }
          }
        },
        assertCurrent,
      ),
    { connectionTimeoutMillis: 10_000, query_timeout: 10_000 },
  );
}
