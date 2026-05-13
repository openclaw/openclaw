import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { z } from "zod";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const DeviceAuthStoreSchema = z.object({
  version: z.literal(1),
  deviceId: z.string(),
  tokens: z.record(z.string(), z.unknown()),
}) as z.ZodType<DeviceAuthStore>;

type DeviceAuthDatabase = Pick<OpenClawStateKyselyDatabase, "device_auth_tokens">;
type DeviceAuthTokenRow = Selectable<DeviceAuthDatabase["device_auth_tokens"]>;
type DeviceAuthTokenInsert = Insertable<DeviceAuthDatabase["device_auth_tokens"]>;

function sqliteOptions(env: NodeJS.ProcessEnv | undefined): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function parseScopesJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

function rowToDeviceAuthEntry(row: DeviceAuthTokenRow): DeviceAuthEntry {
  return {
    token: row.token,
    role: row.role,
    scopes: parseScopesJson(row.scopes_json),
    updatedAtMs: row.updated_at_ms,
  };
}

function deviceAuthEntryToRow(deviceId: string, entry: DeviceAuthEntry): DeviceAuthTokenInsert {
  return {
    device_id: deviceId,
    role: entry.role,
    token: entry.token,
    scopes_json: JSON.stringify(entry.scopes),
    updated_at_ms: entry.updatedAtMs,
  };
}

function upsertDeviceAuthTokenRow(
  db: ReturnType<typeof getNodeSqliteKysely<DeviceAuthDatabase>>,
  sqliteDb: DatabaseSync,
  row: DeviceAuthTokenInsert,
): void {
  executeSqliteQuerySync(
    sqliteDb,
    db
      .insertInto("device_auth_tokens")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["device_id", "role"]).doUpdateSet({
          token: (eb) => eb.ref("excluded.token"),
          scopes_json: (eb) => eb.ref("excluded.scopes_json"),
          updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
        }),
      ),
  );
}

function readDeviceAuthState(env?: NodeJS.ProcessEnv): DeviceAuthStore | null {
  try {
    const database = openOpenClawStateDatabase(sqliteOptions(env));
    const db = getNodeSqliteKysely<DeviceAuthDatabase>(database.db);
    const latest = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("device_auth_tokens")
        .select(["device_id"])
        .orderBy("updated_at_ms", "desc")
        .orderBy("device_id", "asc")
        .limit(1),
    );
    if (!latest) {
      return null;
    }
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("device_auth_tokens")
        .selectAll()
        .where("device_id", "=", latest.device_id)
        .orderBy("role", "asc"),
    ).rows;
    if (rows.length === 0) {
      return null;
    }
    return {
      version: 1,
      deviceId: latest.device_id,
      tokens: Object.fromEntries(rows.map((row) => [row.role, rowToDeviceAuthEntry(row)])),
    };
  } catch {
    return null;
  }
}

function writeDeviceAuthState(env: NodeJS.ProcessEnv | undefined, store: DeviceAuthStore): void {
  const rows = Object.values(store.tokens).map((entry) =>
    deviceAuthEntryToRow(store.deviceId, entry),
  );
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<DeviceAuthDatabase>(database.db);
    if (rows.length === 0) {
      executeSqliteQuerySync(database.db, db.deleteFrom("device_auth_tokens"));
      return;
    }
    const roles = rows.map((row) => row.role);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("device_auth_tokens").where("device_id", "!=", store.deviceId),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("device_auth_tokens")
        .where("device_id", "=", store.deviceId)
        .where("role", "not in", roles),
    );
    for (const row of rows) {
      upsertDeviceAuthTokenRow(db, database.db, row);
    }
  }, sqliteOptions(env));
}

export function loadDeviceAuthStore(
  params: { env?: NodeJS.ProcessEnv } = {},
): DeviceAuthStore | null {
  return readDeviceAuthState(params.env);
}

export function storeDeviceAuthStore(params: {
  store: DeviceAuthStore;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthStore {
  writeDeviceAuthState(params.env, params.store);
  return params.store;
}

export function parseDeviceAuthStoreSnapshot(raw: unknown): DeviceAuthStore | null {
  const store = DeviceAuthStoreSchema.safeParse(raw);
  return store.success ? store.data : null;
}

export function writeDeviceAuthStoreSnapshot(
  env: NodeJS.ProcessEnv | undefined,
  store: DeviceAuthStore,
): void {
  writeDeviceAuthState(env, store);
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const role = normalizeDeviceAuthRole(params.role);
  try {
    const database = openOpenClawStateDatabase(sqliteOptions(params.env));
    const db = getNodeSqliteKysely<DeviceAuthDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("device_auth_tokens")
        .selectAll()
        .where("device_id", "=", params.deviceId)
        .where("role", "=", role),
    );
    return row ? rowToDeviceAuthEntry(row) : null;
  } catch {
    return null;
  }
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const entry: DeviceAuthEntry = {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  const row = deviceAuthEntryToRow(params.deviceId, entry);
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<DeviceAuthDatabase>(database.db);
    upsertDeviceAuthTokenRow(db, database.db, row);
  }, sqliteOptions(params.env));
  return entry;
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const role = normalizeDeviceAuthRole(params.role);
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<DeviceAuthDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("device_auth_tokens")
        .where("device_id", "=", params.deviceId)
        .where("role", "=", role),
    );
  }, sqliteOptions(params.env));
}
