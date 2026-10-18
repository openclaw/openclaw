import { sql } from "kysely";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { OpenClawStateReadRequest } from "../state/openclaw-state-read.types.js";
import {
  decodeGatewayOwnerLease,
  gatewayOwnerKey,
  type GatewayOwnerLeaseRow,
} from "./gateway-owner-lease.read.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
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
      const closeAdmission = schemaMaintenance ? openDoctorStateSchemaReadAdmission(db) : undefined;
      return runWithSqliteCleanup(
        { release: () => closeAdmission?.() },
        "Gateway owner lease schema read admission",
        () => {
          onAdmitted();
          if (!tableExists(db, "state_leases")) {
            return undefined;
          }
          // Like state ownership admission, lease custody cannot trust a damaged lookup index.
          const query =
            /* kysely-allow-raw: maintenance authority inspection requires SQLite's NOT INDEXED table scan. */
            sql<GatewayOwnerLeaseRow>`SELECT owner, created_at AS createdAt,
            expires_at AS expiresAt, heartbeat_at AS heartbeatAt, payload_json AS payloadJson
            FROM state_leases NOT INDEXED
            WHERE scope = ${gatewayOwnerKey.scope} AND lease_key = ${gatewayOwnerKey.key}
            LIMIT 2`;
          const { rows } = executeSqliteQuerySync(db, {
            compile: () => query.compile(getNodeSqliteKysely(db)),
          });
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
