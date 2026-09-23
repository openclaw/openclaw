import type { DatabaseSync } from "node:sqlite";
import {
  type DeviceAuthEntry,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type DeviceAuthTokenObservation = {
  entry: DeviceAuthEntry | null;
  expectedToken: string | null;
};

type DeviceAuthDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "device_auth_tokens" | "gateway_origin_device_tokens"
>;
type DeviceAuthRow = {
  token: string;
  role: string;
  scopes_json: string;
  updated_at_ms: number;
};

function fromRow(row: DeviceAuthRow): DeviceAuthEntry | null {
  try {
    const scopes = JSON.parse(row.scopes_json) as unknown;
    if (!Array.isArray(scopes)) {
      return null;
    }
    return {
      token: row.token,
      role: row.role,
      scopes: normalizeDeviceAuthScopes(scopes),
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return null;
  }
}

export function readDeviceAuthTokenObservationFromDatabase(
  db: DatabaseSync,
  params: { deviceId: string; role: string },
): DeviceAuthTokenObservation {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("device_auth_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("device_id", "=", params.deviceId)
      .where("role", "=", normalizeDeviceAuthRole(params.role)),
  );
  return { entry: row ? fromRow(row) : null, expectedToken: row ? row.token : null };
}

export function readOriginDeviceTokenObservationFromDatabase(
  db: DatabaseSync,
  params: { gatewayScope: string; deviceId: string; role: string },
): DeviceAuthTokenObservation {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("gateway_origin_device_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("gateway_scope", "=", params.gatewayScope)
      .where("device_id", "=", params.deviceId)
      .where("role", "=", normalizeDeviceAuthRole(params.role)),
  );
  return { entry: row ? fromRow(row) : null, expectedToken: row ? row.token : null };
}

export function createDeviceAuthEntry(params: {
  role: string;
  token: string;
  scopes?: string[];
  updatedAtMs?: number;
}): DeviceAuthEntry {
  return {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: params.updatedAtMs ?? Date.now(),
  };
}

export function readDeviceAuthTokensFromDatabase(
  db: DatabaseSync,
  params: { deviceId: string },
): DeviceAuthEntry[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("device_auth_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("device_id", "=", params.deviceId)
      .orderBy("role"),
  ).rows.flatMap((row) => {
    const entry = fromRow(row);
    return entry ? [entry] : [];
  });
}

export function storeDeviceAuthTokenInDatabase(
  db: DatabaseSync,
  params: {
    deviceId: string;
    role: string;
    token: string;
    scopes?: string[];
    updatedAtMs?: number;
    expectedToken?: string | null;
  },
): DeviceAuthEntry | null {
  const entry = createDeviceAuthEntry(params);
  const kysely = getNodeSqliteKysely<DeviceAuthDatabase>(db);
  // A comparison replaces only its observed token or inserts only its observed
  // absence; it cannot overwrite a row that another request rotated or created.
  const result =
    params.expectedToken == null
      ? executeSqliteQuerySync(
          db,
          kysely
            .insertInto("device_auth_tokens")
            .values({
              device_id: params.deviceId,
              role: entry.role,
              token: entry.token,
              scopes_json: JSON.stringify(entry.scopes),
              updated_at_ms: entry.updatedAtMs,
            })
            .onConflict((conflict) =>
              params.expectedToken === null
                ? conflict.columns(["device_id", "role"]).doNothing()
                : conflict.columns(["device_id", "role"]).doUpdateSet({
                    token: entry.token,
                    scopes_json: JSON.stringify(entry.scopes),
                    updated_at_ms: entry.updatedAtMs,
                  }),
            ),
        )
      : executeSqliteQuerySync(
          db,
          kysely
            .updateTable("device_auth_tokens")
            .set({
              token: entry.token,
              scopes_json: JSON.stringify(entry.scopes),
              updated_at_ms: entry.updatedAtMs,
            })
            .where("device_id", "=", params.deviceId)
            .where("role", "=", entry.role)
            .where("token", "=", params.expectedToken),
        );
  return result.numAffectedRows === 1n ? entry : null;
}

export function clearDeviceAuthTokenFromDatabase(
  db: DatabaseSync,
  params: { deviceId: string; role: string; expectedToken?: string; observedToken?: string },
): boolean {
  const baseQuery = getNodeSqliteKysely<DeviceAuthDatabase>(db)
    .deleteFrom("device_auth_tokens")
    .where("device_id", "=", params.deviceId)
    .where("role", "=", normalizeDeviceAuthRole(params.role));
  const query =
    params.expectedToken === undefined
      ? baseQuery
      : params.observedToken !== undefined && params.observedToken.trim() === params.expectedToken
        ? baseQuery.where("token", "in", [params.expectedToken, params.observedToken])
        : baseQuery.where("token", "=", params.expectedToken);
  return executeSqliteQuerySync(db, query).numAffectedRows === 1n;
}

export function storeOriginDeviceTokenInDatabase(
  db: DatabaseSync,
  params: {
    gatewayScope: string;
    deviceId: string;
    role: string;
    token: string;
    scopes?: string[];
    updatedAtMs?: number;
    expectedToken?: string | null;
  },
): DeviceAuthEntry | null {
  const entry = createDeviceAuthEntry(params);
  const kysely = getNodeSqliteKysely<DeviceAuthDatabase>(db);
  const result =
    params.expectedToken == null
      ? executeSqliteQuerySync(
          db,
          kysely
            .insertInto("gateway_origin_device_tokens")
            .values({
              gateway_scope: params.gatewayScope,
              device_id: params.deviceId,
              role: entry.role,
              token: entry.token,
              scopes_json: JSON.stringify(entry.scopes),
              updated_at_ms: entry.updatedAtMs,
            })
            .onConflict((conflict) =>
              params.expectedToken === null
                ? conflict.columns(["gateway_scope", "device_id", "role"]).doNothing()
                : conflict.columns(["gateway_scope", "device_id", "role"]).doUpdateSet({
                    token: entry.token,
                    scopes_json: JSON.stringify(entry.scopes),
                    updated_at_ms: entry.updatedAtMs,
                  }),
            ),
        )
      : executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_origin_device_tokens")
            .set({
              token: entry.token,
              scopes_json: JSON.stringify(entry.scopes),
              updated_at_ms: entry.updatedAtMs,
            })
            .where("gateway_scope", "=", params.gatewayScope)
            .where("device_id", "=", params.deviceId)
            .where("role", "=", entry.role)
            .where("token", "=", params.expectedToken),
        );
  return result.numAffectedRows === 1n ? entry : null;
}

export function clearOriginDeviceTokenInDatabase(
  db: DatabaseSync,
  params: {
    gatewayScope: string;
    deviceId: string;
    role: string;
    expectedToken?: string;
    observedToken?: string;
  },
): boolean {
  const baseQuery = getNodeSqliteKysely<DeviceAuthDatabase>(db)
    .deleteFrom("gateway_origin_device_tokens")
    .where("gateway_scope", "=", params.gatewayScope)
    .where("device_id", "=", params.deviceId)
    .where("role", "=", normalizeDeviceAuthRole(params.role));
  const query =
    params.expectedToken === undefined
      ? baseQuery
      : params.observedToken !== undefined && params.observedToken.trim() === params.expectedToken
        ? baseQuery.where("token", "in", [params.expectedToken, params.observedToken])
        : baseQuery.where("token", "=", params.expectedToken);
  return executeSqliteQuerySync(db, query).numAffectedRows === 1n;
}
