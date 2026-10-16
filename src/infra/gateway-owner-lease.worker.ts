import { sql } from "kysely";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateReadRequest } from "../state/openclaw-state-read.types.js";
import {
  decodeGatewayOwnerLease,
  gatewayOwnerKey,
  type GatewayOwnerLeaseRow,
} from "./gateway-owner-lease.read.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";

/** Lease inspection precedes runtime schema admission, including newer or quarantined state. */
export function inspectGatewayOwnerLease(
  source: Pick<
    OpenClawStateReadRequest,
    "databasePath" | "location" | "expectedIdentity" | "snapshotRoot"
  >,
  onAdmitted: () => void,
  schemaMaintenance: boolean,
): GatewayOwnerLeaseIdentity | undefined {
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
          // SQLite custody cannot trust a damaged lookup index; PostgreSQL uses its admitted catalog.
          const stateDb = getNodeSqliteKysely<Pick<StateDatabase, "state_leases">>(db);
          const query = isPostgresSqlConnection(db)
            ? stateDb
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
        },
      );
    },
  );
}
