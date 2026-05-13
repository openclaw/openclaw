import type { Insertable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  sqliteBooleanInteger,
  sqliteIntegerBoolean,
  sqliteNullableNumber,
  sqliteNullableText,
} from "./sqlite-row-values.js";

export { createAsyncLock } from "./async-lock.js";

type PairingStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "device_bootstrap_tokens"
  | "device_pairing_paired"
  | "device_pairing_pending"
  | "node_pairing_paired"
  | "node_pairing_pending"
>;
type DevicePairingPendingTable = PairingStateDatabase["device_pairing_pending"];
type DevicePairingPairedTable = PairingStateDatabase["device_pairing_paired"];
type DeviceBootstrapTokenTable = PairingStateDatabase["device_bootstrap_tokens"];
type NodePairingPendingTable = PairingStateDatabase["node_pairing_pending"];
type NodePairingPairedTable = PairingStateDatabase["node_pairing_paired"];

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function parseJsonField(value: string | null | undefined): unknown {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function encodeJsonField(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, fallback: string): string {
  const normalized = sqliteNullableText(value);
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function numberOrZero(value: unknown): number {
  return sqliteNullableNumber(value) ?? 0;
}

function rowObject<T>(key: string, value: Record<string, unknown>): [string, T] {
  return [key, value as T];
}

export function readPairingStateRecord<T>(params: {
  baseDir?: string;
  subdir: string;
  key: string;
}): Record<string, T> {
  const database = openOpenClawStateDatabase(sqliteOptionsForBaseDir(params.baseDir));
  const db = getNodeSqliteKysely<PairingStateDatabase>(database.db);

  if (params.subdir === "devices" && params.key === "pending") {
    return Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("device_pairing_pending").selectAll().orderBy("ts", "desc"),
      ).rows.map((row) =>
        rowObject<T>(row.request_id, {
          requestId: row.request_id,
          deviceId: row.device_id,
          publicKey: row.public_key,
          displayName: row.display_name ?? undefined,
          platform: row.platform ?? undefined,
          deviceFamily: row.device_family ?? undefined,
          clientId: row.client_id ?? undefined,
          clientMode: row.client_mode ?? undefined,
          role: row.role ?? undefined,
          roles: parseJsonField(row.roles_json),
          scopes: parseJsonField(row.scopes_json),
          remoteIp: row.remote_ip ?? undefined,
          silent: sqliteIntegerBoolean(row.silent),
          isRepair: sqliteIntegerBoolean(row.is_repair),
          ts: row.ts,
        }),
      ),
    );
  }

  if (params.subdir === "devices" && params.key === "paired") {
    return Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("device_pairing_paired").selectAll().orderBy("approved_at_ms", "desc"),
      ).rows.map((row) =>
        rowObject<T>(row.device_id, {
          deviceId: row.device_id,
          publicKey: row.public_key,
          displayName: row.display_name ?? undefined,
          platform: row.platform ?? undefined,
          deviceFamily: row.device_family ?? undefined,
          clientId: row.client_id ?? undefined,
          clientMode: row.client_mode ?? undefined,
          role: row.role ?? undefined,
          roles: parseJsonField(row.roles_json),
          scopes: parseJsonField(row.scopes_json),
          approvedScopes: parseJsonField(row.approved_scopes_json),
          remoteIp: row.remote_ip ?? undefined,
          tokens: parseJsonField(row.tokens_json),
          createdAtMs: row.created_at_ms,
          approvedAtMs: row.approved_at_ms,
          lastSeenAtMs: row.last_seen_at_ms ?? undefined,
          lastSeenReason: row.last_seen_reason ?? undefined,
        }),
      ),
    );
  }

  if (params.subdir === "devices" && params.key === "bootstrap") {
    return Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("device_bootstrap_tokens").selectAll().orderBy("ts", "desc"),
      ).rows.map((row) =>
        rowObject<T>(row.token_key, {
          token: row.token,
          ts: row.ts,
          deviceId: row.device_id ?? undefined,
          publicKey: row.public_key ?? undefined,
          profile: parseJsonField(row.profile_json),
          redeemedProfile: parseJsonField(row.redeemed_profile_json),
          issuedAtMs: row.issued_at_ms,
          lastUsedAtMs: row.last_used_at_ms ?? undefined,
        }),
      ),
    );
  }

  if (params.subdir === "nodes" && params.key === "pending") {
    return Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("node_pairing_pending").selectAll().orderBy("ts", "desc"),
      ).rows.map((row) =>
        rowObject<T>(row.request_id, {
          requestId: row.request_id,
          nodeId: row.node_id,
          displayName: row.display_name ?? undefined,
          platform: row.platform ?? undefined,
          version: row.version ?? undefined,
          coreVersion: row.core_version ?? undefined,
          uiVersion: row.ui_version ?? undefined,
          deviceFamily: row.device_family ?? undefined,
          modelIdentifier: row.model_identifier ?? undefined,
          caps: parseJsonField(row.caps_json),
          commands: parseJsonField(row.commands_json),
          permissions: parseJsonField(row.permissions_json),
          remoteIp: row.remote_ip ?? undefined,
          silent: sqliteIntegerBoolean(row.silent),
          ts: row.ts,
        }),
      ),
    );
  }

  if (params.subdir === "nodes" && params.key === "paired") {
    return Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("node_pairing_paired").selectAll().orderBy("approved_at_ms", "desc"),
      ).rows.map((row) =>
        rowObject<T>(row.node_id, {
          nodeId: row.node_id,
          token: row.token,
          displayName: row.display_name ?? undefined,
          platform: row.platform ?? undefined,
          version: row.version ?? undefined,
          coreVersion: row.core_version ?? undefined,
          uiVersion: row.ui_version ?? undefined,
          deviceFamily: row.device_family ?? undefined,
          modelIdentifier: row.model_identifier ?? undefined,
          caps: parseJsonField(row.caps_json),
          commands: parseJsonField(row.commands_json),
          permissions: parseJsonField(row.permissions_json),
          remoteIp: row.remote_ip ?? undefined,
          bins: parseJsonField(row.bins_json),
          createdAtMs: row.created_at_ms,
          approvedAtMs: row.approved_at_ms,
          lastConnectedAtMs: row.last_connected_at_ms ?? undefined,
          lastSeenAtMs: row.last_seen_at_ms ?? undefined,
          lastSeenReason: row.last_seen_reason ?? undefined,
        }),
      ),
    );
  }

  return {};
}

export function writePairingStateRecord<T>(params: {
  baseDir?: string;
  subdir: string;
  key: string;
  value: Record<string, T>;
}): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<PairingStateDatabase>(database.db);

    if (params.subdir === "devices" && params.key === "pending") {
      const rows: Insertable<DevicePairingPendingTable>[] = [];
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const requestId = requiredString(entryValue.requestId, entryKey);
        rows.push({
          request_id: requestId,
          device_id: requiredString(entryValue.deviceId, ""),
          public_key: requiredString(entryValue.publicKey, ""),
          display_name: sqliteNullableText(entryValue.displayName),
          platform: sqliteNullableText(entryValue.platform),
          device_family: sqliteNullableText(entryValue.deviceFamily),
          client_id: sqliteNullableText(entryValue.clientId),
          client_mode: sqliteNullableText(entryValue.clientMode),
          role: sqliteNullableText(entryValue.role),
          roles_json: encodeJsonField(entryValue.roles),
          scopes_json: encodeJsonField(entryValue.scopes),
          remote_ip: sqliteNullableText(entryValue.remoteIp),
          silent: sqliteBooleanInteger(entryValue.silent),
          is_repair: sqliteBooleanInteger(entryValue.isRepair),
          ts: numberOrZero(entryValue.ts),
        });
      }
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("device_pairing_pending"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("device_pairing_pending").where(
          "request_id",
          "not in",
          rows.map((row) => row.request_id),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("device_pairing_pending")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("request_id").doUpdateSet({
                device_id: (eb) => eb.ref("excluded.device_id"),
                public_key: (eb) => eb.ref("excluded.public_key"),
                display_name: (eb) => eb.ref("excluded.display_name"),
                platform: (eb) => eb.ref("excluded.platform"),
                device_family: (eb) => eb.ref("excluded.device_family"),
                client_id: (eb) => eb.ref("excluded.client_id"),
                client_mode: (eb) => eb.ref("excluded.client_mode"),
                role: (eb) => eb.ref("excluded.role"),
                roles_json: (eb) => eb.ref("excluded.roles_json"),
                scopes_json: (eb) => eb.ref("excluded.scopes_json"),
                remote_ip: (eb) => eb.ref("excluded.remote_ip"),
                silent: (eb) => eb.ref("excluded.silent"),
                is_repair: (eb) => eb.ref("excluded.is_repair"),
                ts: (eb) => eb.ref("excluded.ts"),
              }),
            ),
        );
      }
      return;
    }

    if (params.subdir === "devices" && params.key === "paired") {
      const rows: Insertable<DevicePairingPairedTable>[] = [];
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const deviceId = requiredString(entryValue.deviceId, entryKey);
        rows.push({
          device_id: deviceId,
          public_key: requiredString(entryValue.publicKey, ""),
          display_name: sqliteNullableText(entryValue.displayName),
          platform: sqliteNullableText(entryValue.platform),
          device_family: sqliteNullableText(entryValue.deviceFamily),
          client_id: sqliteNullableText(entryValue.clientId),
          client_mode: sqliteNullableText(entryValue.clientMode),
          role: sqliteNullableText(entryValue.role),
          roles_json: encodeJsonField(entryValue.roles),
          scopes_json: encodeJsonField(entryValue.scopes),
          approved_scopes_json: encodeJsonField(entryValue.approvedScopes),
          remote_ip: sqliteNullableText(entryValue.remoteIp),
          tokens_json: encodeJsonField(entryValue.tokens),
          created_at_ms: numberOrZero(entryValue.createdAtMs),
          approved_at_ms: numberOrZero(entryValue.approvedAtMs),
          last_seen_at_ms: sqliteNullableNumber(entryValue.lastSeenAtMs),
          last_seen_reason: sqliteNullableText(entryValue.lastSeenReason),
        });
      }
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("device_pairing_paired"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("device_pairing_paired").where(
          "device_id",
          "not in",
          rows.map((row) => row.device_id),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("device_pairing_paired")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("device_id").doUpdateSet({
                public_key: (eb) => eb.ref("excluded.public_key"),
                display_name: (eb) => eb.ref("excluded.display_name"),
                platform: (eb) => eb.ref("excluded.platform"),
                device_family: (eb) => eb.ref("excluded.device_family"),
                client_id: (eb) => eb.ref("excluded.client_id"),
                client_mode: (eb) => eb.ref("excluded.client_mode"),
                role: (eb) => eb.ref("excluded.role"),
                roles_json: (eb) => eb.ref("excluded.roles_json"),
                scopes_json: (eb) => eb.ref("excluded.scopes_json"),
                approved_scopes_json: (eb) => eb.ref("excluded.approved_scopes_json"),
                remote_ip: (eb) => eb.ref("excluded.remote_ip"),
                tokens_json: (eb) => eb.ref("excluded.tokens_json"),
                created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
                approved_at_ms: (eb) => eb.ref("excluded.approved_at_ms"),
                last_seen_at_ms: (eb) => eb.ref("excluded.last_seen_at_ms"),
                last_seen_reason: (eb) => eb.ref("excluded.last_seen_reason"),
              }),
            ),
        );
      }
      return;
    }

    if (params.subdir === "devices" && params.key === "bootstrap") {
      const rows: Insertable<DeviceBootstrapTokenTable>[] = [];
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        rows.push({
          token_key: entryKey,
          token: requiredString(entryValue.token, entryKey),
          ts: numberOrZero(entryValue.ts),
          device_id: sqliteNullableText(entryValue.deviceId),
          public_key: sqliteNullableText(entryValue.publicKey),
          profile_json: encodeJsonField(entryValue.profile),
          redeemed_profile_json: encodeJsonField(entryValue.redeemedProfile),
          issued_at_ms: numberOrZero(entryValue.issuedAtMs),
          last_used_at_ms: sqliteNullableNumber(entryValue.lastUsedAtMs),
        });
      }
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("device_bootstrap_tokens"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("device_bootstrap_tokens").where(
          "token_key",
          "not in",
          rows.map((row) => row.token_key),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("device_bootstrap_tokens")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("token_key").doUpdateSet({
                token: (eb) => eb.ref("excluded.token"),
                ts: (eb) => eb.ref("excluded.ts"),
                device_id: (eb) => eb.ref("excluded.device_id"),
                public_key: (eb) => eb.ref("excluded.public_key"),
                profile_json: (eb) => eb.ref("excluded.profile_json"),
                redeemed_profile_json: (eb) => eb.ref("excluded.redeemed_profile_json"),
                issued_at_ms: (eb) => eb.ref("excluded.issued_at_ms"),
                last_used_at_ms: (eb) => eb.ref("excluded.last_used_at_ms"),
              }),
            ),
        );
      }
      return;
    }

    if (params.subdir === "nodes" && params.key === "pending") {
      const rows: Insertable<NodePairingPendingTable>[] = [];
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const requestId = requiredString(entryValue.requestId, entryKey);
        rows.push({
          request_id: requestId,
          node_id: requiredString(entryValue.nodeId, ""),
          display_name: sqliteNullableText(entryValue.displayName),
          platform: sqliteNullableText(entryValue.platform),
          version: sqliteNullableText(entryValue.version),
          core_version: sqliteNullableText(entryValue.coreVersion),
          ui_version: sqliteNullableText(entryValue.uiVersion),
          device_family: sqliteNullableText(entryValue.deviceFamily),
          model_identifier: sqliteNullableText(entryValue.modelIdentifier),
          caps_json: encodeJsonField(entryValue.caps),
          commands_json: encodeJsonField(entryValue.commands),
          permissions_json: encodeJsonField(entryValue.permissions),
          remote_ip: sqliteNullableText(entryValue.remoteIp),
          silent: sqliteBooleanInteger(entryValue.silent),
          ts: numberOrZero(entryValue.ts),
        });
      }
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("node_pairing_pending"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("node_pairing_pending").where(
          "request_id",
          "not in",
          rows.map((row) => row.request_id),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("node_pairing_pending")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("request_id").doUpdateSet({
                node_id: (eb) => eb.ref("excluded.node_id"),
                display_name: (eb) => eb.ref("excluded.display_name"),
                platform: (eb) => eb.ref("excluded.platform"),
                version: (eb) => eb.ref("excluded.version"),
                core_version: (eb) => eb.ref("excluded.core_version"),
                ui_version: (eb) => eb.ref("excluded.ui_version"),
                device_family: (eb) => eb.ref("excluded.device_family"),
                model_identifier: (eb) => eb.ref("excluded.model_identifier"),
                caps_json: (eb) => eb.ref("excluded.caps_json"),
                commands_json: (eb) => eb.ref("excluded.commands_json"),
                permissions_json: (eb) => eb.ref("excluded.permissions_json"),
                remote_ip: (eb) => eb.ref("excluded.remote_ip"),
                silent: (eb) => eb.ref("excluded.silent"),
                ts: (eb) => eb.ref("excluded.ts"),
              }),
            ),
        );
      }
      return;
    }

    if (params.subdir === "nodes" && params.key === "paired") {
      const rows: Insertable<NodePairingPairedTable>[] = [];
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const nodeId = requiredString(entryValue.nodeId, entryKey);
        rows.push({
          node_id: nodeId,
          token: requiredString(entryValue.token, ""),
          display_name: sqliteNullableText(entryValue.displayName),
          platform: sqliteNullableText(entryValue.platform),
          version: sqliteNullableText(entryValue.version),
          core_version: sqliteNullableText(entryValue.coreVersion),
          ui_version: sqliteNullableText(entryValue.uiVersion),
          device_family: sqliteNullableText(entryValue.deviceFamily),
          model_identifier: sqliteNullableText(entryValue.modelIdentifier),
          caps_json: encodeJsonField(entryValue.caps),
          commands_json: encodeJsonField(entryValue.commands),
          permissions_json: encodeJsonField(entryValue.permissions),
          remote_ip: sqliteNullableText(entryValue.remoteIp),
          bins_json: encodeJsonField(entryValue.bins),
          created_at_ms: numberOrZero(entryValue.createdAtMs),
          approved_at_ms: numberOrZero(entryValue.approvedAtMs),
          last_connected_at_ms: sqliteNullableNumber(entryValue.lastConnectedAtMs),
          last_seen_at_ms: sqliteNullableNumber(entryValue.lastSeenAtMs),
          last_seen_reason: sqliteNullableText(entryValue.lastSeenReason),
        });
      }
      if (rows.length === 0) {
        executeSqliteQuerySync(database.db, db.deleteFrom("node_pairing_paired"));
        return;
      }
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("node_pairing_paired").where(
          "node_id",
          "not in",
          rows.map((row) => row.node_id),
        ),
      );
      for (const row of rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("node_pairing_paired")
            .values(row)
            .onConflict((conflict) =>
              conflict.column("node_id").doUpdateSet({
                token: (eb) => eb.ref("excluded.token"),
                display_name: (eb) => eb.ref("excluded.display_name"),
                platform: (eb) => eb.ref("excluded.platform"),
                version: (eb) => eb.ref("excluded.version"),
                core_version: (eb) => eb.ref("excluded.core_version"),
                ui_version: (eb) => eb.ref("excluded.ui_version"),
                device_family: (eb) => eb.ref("excluded.device_family"),
                model_identifier: (eb) => eb.ref("excluded.model_identifier"),
                caps_json: (eb) => eb.ref("excluded.caps_json"),
                commands_json: (eb) => eb.ref("excluded.commands_json"),
                permissions_json: (eb) => eb.ref("excluded.permissions_json"),
                remote_ip: (eb) => eb.ref("excluded.remote_ip"),
                bins_json: (eb) => eb.ref("excluded.bins_json"),
                created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
                approved_at_ms: (eb) => eb.ref("excluded.approved_at_ms"),
                last_connected_at_ms: (eb) => eb.ref("excluded.last_connected_at_ms"),
                last_seen_at_ms: (eb) => eb.ref("excluded.last_seen_at_ms"),
                last_seen_reason: (eb) => eb.ref("excluded.last_seen_reason"),
              }),
            ),
        );
      }
    }
  }, sqliteOptionsForBaseDir(params.baseDir));
}

export function coercePairingStateRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, T>;
}

export function pruneExpiredPending<T extends { ts: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > ttlMs) {
      delete pendingById[id];
    }
  }
}

export type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

export async function reconcilePendingPairingRequests<
  TPending extends { requestId: string },
  TIncoming,
>(params: {
  pendingById: Record<string, TPending>;
  existing: readonly TPending[];
  incoming: TIncoming;
  canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
  refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
  buildReplacement: (params: { existing: readonly TPending[]; incoming: TIncoming }) => TPending;
  persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>> {
  if (
    params.existing.length === 1 &&
    params.canRefreshSingle(params.existing[0], params.incoming)
  ) {
    const refreshed = params.refreshSingle(params.existing[0], params.incoming);
    params.pendingById[refreshed.requestId] = refreshed;
    await params.persist();
    return { status: "pending", request: refreshed, created: false };
  }

  for (const existing of params.existing) {
    delete params.pendingById[existing.requestId];
  }

  const request = params.buildReplacement({
    existing: params.existing,
    incoming: params.incoming,
  });
  params.pendingById[request.requestId] = request;
  await params.persist();
  return { status: "pending", request, created: true };
}
