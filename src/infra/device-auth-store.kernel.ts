import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder } from "kysely";
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
type DeviceAuthRow = Pick<
  DeviceAuthDatabase["device_auth_tokens"],
  "token" | "role" | "scopes_json" | "updated_at_ms"
>;
type DeviceAuthLookup = { deviceId: string; role: string };
type DeviceAuthWrite = DeviceAuthLookup &
  Parameters<typeof createDeviceAuthEntry>[0] & { expectedToken?: string | null };
type DeviceAuthClear = DeviceAuthLookup & { expectedToken?: string; observedToken?: string };

function tokenTarget(params: DeviceAuthLookup, origin?: { gatewayScope: string }) {
  const key = { device_id: params.deviceId, role: normalizeDeviceAuthRole(params.role) };
  const eb = expressionBuilder<DeviceAuthDatabase, keyof DeviceAuthDatabase>();
  const match = eb.and([
    ...(origin === undefined ? [] : [eb("gateway_scope", "=", origin.gatewayScope)]),
    eb("device_id", "=", key.device_id),
    eb("role", "=", key.role),
  ]);
  return origin === undefined
    ? { table: "device_auth_tokens" as const, key, match }
    : {
        table: "gateway_origin_device_tokens" as const,
        key: { gateway_scope: origin.gatewayScope, ...key },
        match,
      };
}

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
  params: DeviceAuthLookup,
): DeviceAuthTokenObservation {
  return readTokenObservation(db, tokenTarget(params));
}

export function readOriginDeviceTokenObservationFromDatabase(
  db: DatabaseSync,
  params: DeviceAuthLookup & { gatewayScope: string },
): DeviceAuthTokenObservation {
  return readTokenObservation(db, tokenTarget(params, params));
}

function readTokenObservation(
  db: DatabaseSync,
  target: ReturnType<typeof tokenTarget>,
): DeviceAuthTokenObservation {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom(target.table)
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where(target.match),
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
  params: DeviceAuthWrite,
): DeviceAuthEntry | null {
  return storeToken(db, params, tokenTarget(params));
}

export function storeOriginDeviceTokenInDatabase(
  db: DatabaseSync,
  params: DeviceAuthWrite & { gatewayScope: string },
): DeviceAuthEntry | null {
  return storeToken(db, params, tokenTarget(params, params));
}

function storeToken(
  db: DatabaseSync,
  params: DeviceAuthWrite,
  target: ReturnType<typeof tokenTarget>,
): DeviceAuthEntry | null {
  const entry = createDeviceAuthEntry(params);
  const kysely = getNodeSqliteKysely<DeviceAuthDatabase>(db);
  const values = {
    token: entry.token,
    scopes_json: JSON.stringify(entry.scopes),
    updated_at_ms: entry.updatedAtMs,
  };
  // A comparison replaces only its observed token or inserts only its observed
  // absence; it cannot overwrite a row that another request rotated or created.
  const query =
    params.expectedToken == null
      ? kysely
          .insertInto(target.table)
          .values({ ...target.key, ...values })
          .onConflict((conflict) => {
            const keyed = conflict.columns(
              target.table === "device_auth_tokens"
                ? ["device_id", "role"]
                : ["gateway_scope", "device_id", "role"],
            );
            return params.expectedToken === null ? keyed.doNothing() : keyed.doUpdateSet(values);
          })
      : kysely
          .updateTable(target.table)
          .set(values)
          .where(target.match)
          .where("token", "=", params.expectedToken);
  return executeSqliteQuerySync(db, query).numAffectedRows === 1n ? entry : null;
}

export function clearDeviceAuthTokenFromDatabase(
  db: DatabaseSync,
  params: DeviceAuthClear,
): boolean {
  return clearToken(db, params, tokenTarget(params));
}

export function clearOriginDeviceTokenInDatabase(
  db: DatabaseSync,
  params: DeviceAuthClear & { gatewayScope: string },
): boolean {
  return clearToken(db, params, tokenTarget(params, params));
}

function clearToken(
  db: DatabaseSync,
  params: DeviceAuthClear,
  target: ReturnType<typeof tokenTarget>,
): boolean {
  const baseQuery = getNodeSqliteKysely<DeviceAuthDatabase>(db)
    .deleteFrom(target.table)
    .where(target.match);
  const query =
    params.expectedToken === undefined
      ? baseQuery
      : params.observedToken !== undefined && params.observedToken.trim() === params.expectedToken
        ? baseQuery.where("token", "in", [params.expectedToken, params.observedToken])
        : baseQuery.where("token", "=", params.expectedToken);
  return executeSqliteQuerySync(db, query).numAffectedRows === 1n;
}
