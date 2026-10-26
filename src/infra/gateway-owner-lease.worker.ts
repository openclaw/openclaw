import { sql } from "kysely";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import {
  assertStateFileSnapshotAllowed,
  stateEngineInput,
  stateEngineSchema,
} from "../state/openclaw-state-db-engine.js";
import { openTrackedStateDatabase } from "../state/openclaw-state-db-handle.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateReadRequest } from "../state/openclaw-state-read.types.js";
import { databaseEngineAdapters } from "./database-engine/adapters.js";
import { readEngineAnchor } from "./database-engine/open.js";
import {
  decodeGatewayOwnerLease,
  gatewayOwnerKey,
  GATEWAY_OWNER_LEASE_COLUMNS_SQL,
  assertGatewayOwnerLeaseColumns,
  type GatewayOwnerLeaseRow,
} from "./gateway-owner-lease.read.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  isPostgresSqlConnection,
  type EngineConnection,
  type PostgresSqlConnection,
} from "./sql-connection.js";
import { runWithSqliteCleanup, throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

type LeaseReadSource = Pick<
  OpenClawStateReadRequest,
  "databasePath" | "location" | "expectedIdentity" | "snapshotRoot"
>;

/** Recovery reads only the stable lease contract, never the candidate's application schema. */
function inspectPostgresGatewayOwnerLease(
  source: LeaseReadSource,
  input: NonNullable<ReturnType<typeof stateEngineInput>>,
  onAdmitted: () => void,
): GatewayOwnerLeaseIdentity | undefined {
  if (source.location !== source.databasePath || source.snapshotRoot) {
    assertStateFileSnapshotAllowed();
  }
  const anchor = openTrackedStateDatabase(source.databasePath, {
    existingOnly: true,
    expectedIdentity: source.expectedIdentity,
  });
  let db: PostgresSqlConnection | undefined;
  return runWithSqliteCleanup(
    {
      release: () =>
        throwSqliteLifecycleErrors(
          openClawStateDatabaseCache.closeUnpublishedOpenClawStateDatabaseHandle({
            db: db ?? anchor,
            path: source.databasePath,
          }),
          "Gateway owner lease reader cleanup failed",
        ),
    },
    "PostgreSQL Gateway owner lease inspection",
    () => {
      const rows = readEngineAnchor(anchor, "identity", true);
      const identity = rows?.[0];
      if (
        rows?.length !== 1 ||
        identity?.engine !== "postgres" ||
        typeof identity.store_id !== "string" ||
        typeof identity.schema !== "string" ||
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identity.schema)
      ) {
        throw new Error("Invalid PostgreSQL anchor identity during Gateway owner lease inspection");
      }
      const { store_id: storeId, schema: namespace } = identity;
      const connection = databaseEngineAdapters.postgres.openConnection({
        anchor,
        input,
        schema: stateEngineSchema,
        storeId,
        namespace,
        openSqlite: () => {},
      });
      db = connection;
      return connection.runTransaction(
        () => {
          const metadata = connection
            .prepare(
              `SELECT version, store_id FROM ${quoteSqliteIdentifier(namespace)}.openclaw_schema_meta WHERE store = 'state' LIMIT 2`,
            )
            .all();
          if (
            metadata.length !== 1 ||
            metadata[0]?.store_id !== storeId ||
            typeof metadata[0]?.version !== "number" ||
            !Number.isInteger(metadata[0].version) ||
            metadata[0].version < 1
          ) {
            throw new Error(
              "PostgreSQL state identity could not be verified for Gateway owner lease inspection",
            );
          }
          assertGatewayOwnerLeaseColumns(
            connection.prepare(GATEWAY_OWNER_LEASE_COLUMNS_SQL).all(namespace),
          );
          onAdmitted();
          return readGatewayOwnerLeaseRows(connection, namespace);
        },
        undefined,
        true,
      );
    },
  );
}

/** Lease inspection precedes runtime schema admission, including newer or quarantined state. */
export function inspectGatewayOwnerLease(
  source: LeaseReadSource,
  onAdmitted: () => void,
  schemaMaintenance: boolean,
): GatewayOwnerLeaseIdentity | undefined {
  const postgres = schemaMaintenance ? stateEngineInput() : undefined;
  if (postgres) {
    return inspectPostgresGatewayOwnerLease(source, postgres, onAdmitted);
  }
  const connection = openOpenClawStateReadConnection(
    source.databasePath,
    source.location,
    source.expectedIdentity,
    source.snapshotRoot,
  );
  return runWithSqliteCleanup(
    {
      release: () => {
        connection.close();
      },
    },
    "Gateway owner lease inspection",
    () => {
      const db = connection.database.db;
      let closeAdmission: (() => void) | undefined;
      if (schemaMaintenance) {
        closeAdmission = openDoctorStateSchemaReadAdmission(db);
      }
      return runWithSqliteCleanup(
        { release: () => closeAdmission?.() },
        "Gateway owner lease schema read admission",
        () => {
          onAdmitted();
          if (!tableExists(db, "state_leases")) {
            return undefined;
          }
          return readGatewayOwnerLeaseRows(db);
        },
      );
    },
  );
}

function readGatewayOwnerLeaseRows(
  db: EngineConnection,
  namespace?: string,
): GatewayOwnerLeaseIdentity | undefined {
  // SQLite custody cannot trust a damaged lookup index; PostgreSQL uses its admitted table.
  const stateDb = getNodeSqliteKysely<Pick<StateDatabase, "state_leases">>(db);
  const query = isPostgresSqlConnection(db)
    ? (namespace ? stateDb.withSchema(namespace) : stateDb)
        .selectFrom("state_leases")
        .select([
          "owner",
          "created_at as createdAt",
          "expires_at as expiresAt",
          "heartbeat_at as heartbeatAt",
          "payload_json as payloadJson",
        ])
        .where("scope", "=", gatewayOwnerKey.scope)
        .where("lease_key", "=", gatewayOwnerKey.key)
        .limit(2)
    : {
        compile: () =>
          /* kysely-allow-raw: maintenance authority inspection requires SQLite's NOT INDEXED table scan. */
          sql<GatewayOwnerLeaseRow>`SELECT owner, created_at AS createdAt,
            expires_at AS expiresAt, heartbeat_at AS heartbeatAt, payload_json AS payloadJson
            FROM ${sql`state_leases NOT INDEXED`}
            WHERE scope = ${gatewayOwnerKey.scope} AND lease_key = ${gatewayOwnerKey.key}
            LIMIT 2`.compile(stateDb),
      };
  const { rows } = executeSqliteQuerySync(db, query);
  if (rows.length > 1) {
    throw new Error(
      "Gateway owner lease identity is ambiguous during maintenance; stop OpenClaw processes and restore a verified state backup before retrying",
    );
  }
  return decodeGatewayOwnerLease(rows[0]);
}
