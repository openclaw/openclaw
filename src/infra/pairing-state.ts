import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export { createAsyncLock } from "./async-lock.js";

type PairingStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "device_bootstrap_tokens"
  | "device_pairing_paired"
  | "device_pairing_pending"
  | "node_pairing_paired"
  | "node_pairing_pending"
>;

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

function normalizeBoolean(value: unknown): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function decodeOptionalBoolean(value: number | null | undefined): boolean | undefined {
  return typeof value === "number" ? value !== 0 : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, fallback: string): string {
  const normalized = optionalString(value);
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
          silent: decodeOptionalBoolean(row.silent),
          isRepair: decodeOptionalBoolean(row.is_repair),
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
          silent: decodeOptionalBoolean(row.silent),
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
      executeSqliteQuerySync(database.db, db.deleteFrom("device_pairing_pending"));
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const requestId = requiredString(entryValue.requestId, entryKey);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("device_pairing_pending").values({
            request_id: requestId,
            device_id: requiredString(entryValue.deviceId, ""),
            public_key: requiredString(entryValue.publicKey, ""),
            display_name: optionalString(entryValue.displayName),
            platform: optionalString(entryValue.platform),
            device_family: optionalString(entryValue.deviceFamily),
            client_id: optionalString(entryValue.clientId),
            client_mode: optionalString(entryValue.clientMode),
            role: optionalString(entryValue.role),
            roles_json: encodeJsonField(entryValue.roles),
            scopes_json: encodeJsonField(entryValue.scopes),
            remote_ip: optionalString(entryValue.remoteIp),
            silent: normalizeBoolean(entryValue.silent),
            is_repair: normalizeBoolean(entryValue.isRepair),
            ts: numberOrZero(entryValue.ts),
          }),
        );
      }
      return;
    }

    if (params.subdir === "devices" && params.key === "paired") {
      executeSqliteQuerySync(database.db, db.deleteFrom("device_pairing_paired"));
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const deviceId = requiredString(entryValue.deviceId, entryKey);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("device_pairing_paired").values({
            device_id: deviceId,
            public_key: requiredString(entryValue.publicKey, ""),
            display_name: optionalString(entryValue.displayName),
            platform: optionalString(entryValue.platform),
            device_family: optionalString(entryValue.deviceFamily),
            client_id: optionalString(entryValue.clientId),
            client_mode: optionalString(entryValue.clientMode),
            role: optionalString(entryValue.role),
            roles_json: encodeJsonField(entryValue.roles),
            scopes_json: encodeJsonField(entryValue.scopes),
            approved_scopes_json: encodeJsonField(entryValue.approvedScopes),
            remote_ip: optionalString(entryValue.remoteIp),
            tokens_json: encodeJsonField(entryValue.tokens),
            created_at_ms: numberOrZero(entryValue.createdAtMs),
            approved_at_ms: numberOrZero(entryValue.approvedAtMs),
            last_seen_at_ms: maybeNumber(entryValue.lastSeenAtMs),
            last_seen_reason: optionalString(entryValue.lastSeenReason),
          }),
        );
      }
      return;
    }

    if (params.subdir === "devices" && params.key === "bootstrap") {
      executeSqliteQuerySync(database.db, db.deleteFrom("device_bootstrap_tokens"));
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          db.insertInto("device_bootstrap_tokens").values({
            token_key: entryKey,
            token: requiredString(entryValue.token, entryKey),
            ts: numberOrZero(entryValue.ts),
            device_id: optionalString(entryValue.deviceId),
            public_key: optionalString(entryValue.publicKey),
            profile_json: encodeJsonField(entryValue.profile),
            redeemed_profile_json: encodeJsonField(entryValue.redeemedProfile),
            issued_at_ms: numberOrZero(entryValue.issuedAtMs),
            last_used_at_ms: maybeNumber(entryValue.lastUsedAtMs),
          }),
        );
      }
      return;
    }

    if (params.subdir === "nodes" && params.key === "pending") {
      executeSqliteQuerySync(database.db, db.deleteFrom("node_pairing_pending"));
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const requestId = requiredString(entryValue.requestId, entryKey);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("node_pairing_pending").values({
            request_id: requestId,
            node_id: requiredString(entryValue.nodeId, ""),
            display_name: optionalString(entryValue.displayName),
            platform: optionalString(entryValue.platform),
            version: optionalString(entryValue.version),
            core_version: optionalString(entryValue.coreVersion),
            ui_version: optionalString(entryValue.uiVersion),
            device_family: optionalString(entryValue.deviceFamily),
            model_identifier: optionalString(entryValue.modelIdentifier),
            caps_json: encodeJsonField(entryValue.caps),
            commands_json: encodeJsonField(entryValue.commands),
            permissions_json: encodeJsonField(entryValue.permissions),
            remote_ip: optionalString(entryValue.remoteIp),
            silent: normalizeBoolean(entryValue.silent),
            ts: numberOrZero(entryValue.ts),
          }),
        );
      }
      return;
    }

    if (params.subdir === "nodes" && params.key === "paired") {
      executeSqliteQuerySync(database.db, db.deleteFrom("node_pairing_paired"));
      for (const [entryKey, entryValue] of Object.entries(params.value)) {
        if (!isRecord(entryValue)) {
          continue;
        }
        const nodeId = requiredString(entryValue.nodeId, entryKey);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("node_pairing_paired").values({
            node_id: nodeId,
            token: requiredString(entryValue.token, ""),
            display_name: optionalString(entryValue.displayName),
            platform: optionalString(entryValue.platform),
            version: optionalString(entryValue.version),
            core_version: optionalString(entryValue.coreVersion),
            ui_version: optionalString(entryValue.uiVersion),
            device_family: optionalString(entryValue.deviceFamily),
            model_identifier: optionalString(entryValue.modelIdentifier),
            caps_json: encodeJsonField(entryValue.caps),
            commands_json: encodeJsonField(entryValue.commands),
            permissions_json: encodeJsonField(entryValue.permissions),
            remote_ip: optionalString(entryValue.remoteIp),
            bins_json: encodeJsonField(entryValue.bins),
            created_at_ms: numberOrZero(entryValue.createdAtMs),
            approved_at_ms: numberOrZero(entryValue.approvedAtMs),
            last_connected_at_ms: maybeNumber(entryValue.lastConnectedAtMs),
            last_seen_at_ms: maybeNumber(entryValue.lastSeenAtMs),
            last_seen_reason: optionalString(entryValue.lastSeenReason),
          }),
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
