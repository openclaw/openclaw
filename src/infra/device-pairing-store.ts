// SQLite row mapping for device pairing and bootstrap-token snapshots.
// The worker owns runtime mutations; native callers hold offline or boot custody.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolvePairingSetupAccess } from "../shared/device-bootstrap-profile.js";
import {
  ensureDevicePairSetupBootstrapSchema,
  ensureDevicePairSetupCompletionSchema,
} from "../state/openclaw-state-db-schema-additive.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  DeviceBootstrapTokens,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { sha256Base64Url } from "./crypto-digest.js";
import { clearDeviceAuthTokenFromDatabase } from "./device-auth-store.kernel.js";
import { resolveDeviceBootstrapTokenExpiresAtMs } from "./device-bootstrap.worker-types.js";
import { bindCloudWorkerSetupCompletion } from "./device-pairing-cloud-worker.js";
import type { PairedDeviceMetadataPatch } from "./device-pairing-core.types.js";
import { invalidateDevicePairingNodeSnapshot } from "./device-pairing-publication.js";
import type { CloudWorkerSetupCompletionPublication } from "./device-pairing-read.types.js";
import {
  toJsonColumn,
  toPendingRow,
  fromPendingRow,
  toPairedRow,
  fromPairedRow,
  toBootstrapRow,
  fromBootstrapRow,
  fromSetupCompletionRow,
} from "./device-pairing-row-mapping.js";
import {
  invalidateDevicePairingStoreCache,
  readCachedDevicePairingStoreSnapshot,
} from "./device-pairing-store-cache.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairingPendingRecord,
  DevicePairingStoreState,
  DevicePairSetupCompletionRecord,
  PairedDevice,
} from "./device-pairing.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { clearApnsRegistrationFromDatabase } from "./push-apns-store-transaction.js";
import type { EngineConnection } from "./sql-connection.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

export type { DevicePairingStoreState } from "./device-pairing.types.js";

const DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP = [
  "device_id",
  "issued_at_ms",
  "last_used_at_ms",
  "pending_profile_json",
  "profile_json",
  "public_key",
  "redeemed_profile_json",
  "token",
  "token_key",
  "ts",
] as const satisfies readonly (keyof DeviceBootstrapTokens)[];

type DevicePairingStoreMutation<T> = {
  mutated: boolean;
  value: T;
};

type PairedDeviceUpdate<T> = {
  value: T;
  patch?: Partial<PairedDeviceMetadataPatch & Pick<PairedDevice, "tokens" | "nodeSurface">>;
};

const boundDatabase = new AsyncLocalStorage<{
  database: OpenClawStateDatabase;
  paired?: Record<string, PairedDevice>;
}>();

/** Keep nested domain kernels on the broker's admitted physical connection. */
export function withDevicePairingStoreDatabase<T>(
  database: OpenClawStateDatabase,
  operate: () => T,
  paired?: Record<string, PairedDevice>,
): T {
  return boundDatabase.run({ database, paired }, operate);
}

function transactionPairedRecords(db: EngineConnection): Record<string, PairedDevice> | undefined {
  const bound = boundDatabase.getStore();
  return bound?.database.db === db ? bound.paired : undefined;
}

/** Route an explicit pairing base dir (tests, alternate state roots) to that dir's DB. */
function resolveDevicePairingStateDbOptions(baseDir?: string): OpenClawStateDatabaseOptions {
  const database = boundDatabase.getStore()?.database;
  if (database) {
    return { database, path: database.path, env: getSqliteWorkerStateContext().environment };
  }
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function runDevicePairingStoreMutation<T>(
  baseDir: string | undefined,
  mutate: (database: OpenClawStateDatabase) => DevicePairingStoreMutation<T>,
): T {
  const databaseOptions = resolveDevicePairingStateDbOptions(baseDir);
  const database = openOpenClawStateDatabase(databaseOptions);
  return runOpenClawStateWriteTransaction(
    (transactionDatabase) => {
      const result = mutate(transactionDatabase);
      if (result.mutated) {
        // Transaction-local reads bypass the cache; only real commits invalidate it.
        stageSqliteTransactionState(transactionDatabase.db, {
          stage: () => undefined,
          rollback: () => undefined,
          commit: () => {
            invalidateDevicePairingStoreCache(transactionDatabase);
            invalidateDevicePairingNodeSnapshot(transactionDatabase.path);
          },
        });
      }
      return result.value;
    },
    { ...databaseOptions, database },
  );
}

export function readDevicePairingStoreStateFromDatabase(
  db: EngineConnection,
): DevicePairingStoreState {
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const pendingById: Record<string, DevicePairingPendingRecord> = {};
  for (const row of executeSqliteQuerySync(
    db,
    kysely.selectFrom("device_pairing_pending").selectAll(),
  ).rows) {
    pendingById[row.request_id] = fromPendingRow(row);
  }
  return { pendingById, pairedByDeviceId: readPairedDevicePairingRecordsFromDatabase(db) };
}

export function readPairedDevicePairingRecordsFromDatabase(
  db: EngineConnection,
): Record<string, PairedDevice> {
  const paired = transactionPairedRecords(db);
  if (paired) {
    return structuredClone(paired);
  }
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  return Object.fromEntries(
    executeSqliteQuerySync(db, kysely.selectFrom("device_pairing_paired").selectAll()).rows.map(
      (row) => [row.device_id, fromPairedRow(row)],
    ),
  );
}

export function loadDevicePairingStoreState(baseDir?: string): DevicePairingStoreState {
  const database = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  return structuredClone(
    readCachedDevicePairingStoreSnapshot(database.db, database.path, () =>
      readDevicePairingStoreStateFromDatabase(database.db),
    ).state,
  );
}

/** Load one paired-device row from an existing shared-state transaction. */
export function loadPairedDevicePairingStoreRecordFromDatabase(
  db: OpenClawStateDatabase["db"],
  deviceId: string,
): PairedDevice | null {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    return null;
  }
  const paired = transactionPairedRecords(db);
  if (paired) {
    return Object.hasOwn(paired, normalizedDeviceId)
      ? structuredClone(paired[normalizedDeviceId]!)
      : null;
  }
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("device_pairing_paired")
      .selectAll()
      .where("device_id", "=", normalizedDeviceId),
  );
  return row ? fromPairedRow(row) : null;
}

/** Read and patch one device under the worker's transaction and commit admission. */
export function updatePairedDeviceInTransaction<T>(
  deviceId: string,
  update: (device: PairedDevice | null) => PairedDeviceUpdate<T>,
): T {
  return runDevicePairingStoreMutation(undefined, ({ db }) => {
    const normalizedDeviceId = deviceId.trim();
    const device = loadPairedDevicePairingStoreRecordFromDatabase(db, normalizedDeviceId);
    // Kernels may mutate their borrowed row while building the patch.
    const stored = device ? toPairedRow(device) : undefined;
    const result = update(device);
    const patch = result.patch;
    if (!patch || Object.keys(patch).length === 0) {
      return { mutated: false, value: result.value };
    }
    if (!device) {
      throw new Error("cannot update a missing paired device");
    }
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    const columns = {
      ...("displayName" in patch ? { display_name: patch.displayName ?? null } : {}),
      ...("operatorLabel" in patch ? { operator_label: patch.operatorLabel ?? null } : {}),
      ...("platform" in patch ? { platform: patch.platform ?? null } : {}),
      ...("clientId" in patch ? { client_id: patch.clientId ?? null } : {}),
      ...("clientMode" in patch ? { client_mode: patch.clientMode ?? null } : {}),
      ...("remoteIp" in patch ? { remote_ip: patch.remoteIp ?? null } : {}),
      ...("lastSeenAtMs" in patch ? { last_seen_at_ms: patch.lastSeenAtMs ?? null } : {}),
      ...("lastSeenReason" in patch ? { last_seen_reason: patch.lastSeenReason ?? null } : {}),
      ...("tokens" in patch ? { tokens_json: toJsonColumn(patch.tokens) } : {}),
      ...("nodeSurface" in patch ? { node_surface_json: toJsonColumn(patch.nodeSurface) } : {}),
    };
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("device_pairing_paired")
        .set(columns)
        .where("device_id", "=", normalizedDeviceId),
    );
    const paired = transactionPairedRecords(db);
    if (paired && stored) {
      paired[normalizedDeviceId] = fromPairedRow({ ...stored, ...columns });
    }
    return { mutated: true, value: result.value };
  });
}

/** Replace the pending and/or paired table contents with the given snapshot. */
export function persistDevicePairingStoreState(
  state: DevicePairingStoreState,
  baseDir: string | undefined,
  target: "pending" | "paired" | "both",
  options?: {
    clearApnsNodeIds?: readonly string[];
    retiredNodeToken?: { deviceId: string; expectedToken: string };
  },
): void {
  runDevicePairingStoreMutation(baseDir, ({ db }) => {
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    const pairedRows =
      target !== "pending" ? Object.values(state.pairedByDeviceId).map(toPairedRow) : undefined;
    if (target !== "paired") {
      executeSqliteQuerySync(db, kysely.deleteFrom("device_pairing_pending"));
      const rows = Object.values(state.pendingById).map(toPendingRow);
      if (rows.length > 0) {
        executeSqliteQuerySync(db, kysely.insertInto("device_pairing_pending").values(rows));
      }
    }
    if (pairedRows) {
      executeSqliteQuerySync(db, kysely.deleteFrom("device_pairing_paired"));
      if (pairedRows.length > 0) {
        executeSqliteQuerySync(db, kysely.insertInto("device_pairing_paired").values(pairedRows));
      }
    }
    for (const nodeId of new Set(options?.clearApnsNodeIds ?? [])) {
      clearApnsRegistrationFromDatabase(db, nodeId);
    }
    if (options?.retiredNodeToken) {
      clearDeviceAuthTokenFromDatabase(db, { ...options.retiredNodeToken, role: "node" });
    }
    const paired = transactionPairedRecords(db);
    if (paired && pairedRows) {
      for (const deviceId of Object.keys(paired)) {
        delete paired[deviceId];
      }
      for (const row of pairedRows) {
        Object.defineProperty(paired, row.device_id, {
          value: fromPairedRow(row),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
    }
    return { mutated: true, value: undefined };
  });
}

export function loadDeviceBootstrapTokenRecords(
  baseDir?: string,
): Record<string, DeviceBootstrapTokenRecord> {
  const { db } = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  return readDeviceBootstrapTokenRecordsFromDatabase(db);
}

export function readDeviceBootstrapTokenRecordsFromDatabase(
  db: EngineConnection,
): Record<string, DeviceBootstrapTokenRecord> {
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const state: Record<string, DeviceBootstrapTokenRecord> = {};
  const hasSetupId = tableHasColumn(db, "device_bootstrap_tokens", "setup_id");
  const rows: DeviceBootstrapTokens[] = hasSetupId
    ? executeSqliteQuerySync(db, kysely.selectFrom("device_bootstrap_tokens").selectAll()).rows
    : executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("device_bootstrap_tokens")
          .select(DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP),
      ).rows.map((row) => Object.assign(row, { setup_id: null }));
  for (const row of rows) {
    state[row.token_key] = fromBootstrapRow(row);
  }
  return state;
}

/** Replace the bootstrap token table contents with the given snapshot. */
export function persistDeviceBootstrapTokenRecords(
  state: Record<string, DeviceBootstrapTokenRecord>,
  baseDir?: string,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const rows = Object.entries(state).map(([tokenKey, record]) =>
      toBootstrapRow(tokenKey, record),
    );
    if (rows.some((row) => row.setup_id !== null)) {
      ensureDevicePairSetupBootstrapSchema(db);
    }
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    executeSqliteQuerySync(db, kysely.deleteFrom("device_bootstrap_tokens"));
    if (rows.length > 0) {
      if (tableHasColumn(db, "device_bootstrap_tokens", "setup_id")) {
        executeSqliteQuerySync(db, kysely.insertInto("device_bootstrap_tokens").values(rows));
      } else {
        const rowsWithoutSetup = rows.map(({ setup_id: _setupId, ...row }) => row);
        executeSqliteQuerySync(
          db,
          kysely.insertInto("device_bootstrap_tokens").values(rowsWithoutSetup),
        );
      }
    }
  }, resolveDevicePairingStateDbOptions(baseDir));
}

/** Consume one bound bootstrap credential and record its setup outcome atomically. */
export function consumeDeviceBootstrapTokenWithSetupCompletionInTransaction(params: {
  token: string;
  deviceId: string;
  completedAtMs: number;
  nowMs: number;
  retentionNowMs: number;
  retainUntilMs: number;
  pairedDeviceMatches?: (
    device: PairedDevice | null,
    record: DeviceBootstrapTokenRecord,
  ) => boolean;
  recordWorkerEnvironment: (facts: CloudWorkerSetupCompletionPublication) => void;
}): { record: DeviceBootstrapTokenRecord; completion?: DevicePairSetupCompletionRecord } | null {
  const token = params.token.trim();
  const deviceId = params.deviceId.trim();
  if (!token || !deviceId) {
    return null;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    ensureDevicePairSetupBootstrapSchema(db);
    ensureDevicePairSetupCompletionSchema(db);
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    // Verification precedes async pairing work, so expiry must be checked again
    // against the authoritative row before consumption becomes terminal.
    const tokenRow = executeSqliteQueryTakeFirstSync(
      db,
      kysely.selectFrom("device_bootstrap_tokens").selectAll().where("token_key", "=", token),
    );
    if (!tokenRow || tokenRow.token !== token || tokenRow.device_id?.trim() !== deviceId) {
      return null;
    }
    const record = fromBootstrapRow(tokenRow);
    if (params.nowMs > resolveDeviceBootstrapTokenExpiresAtMs(record)) {
      return null;
    }
    const paired =
      record.setupId || params.pairedDeviceMatches
        ? loadPairedDevicePairingStoreRecordFromDatabase(db, deviceId)
        : null;
    if (params.pairedDeviceMatches && !params.pairedDeviceMatches(paired, record)) {
      return null;
    }
    const deviceName = paired?.operatorLabel ?? paired?.displayName;
    const completion: DevicePairSetupCompletionRecord | undefined = record.setupId
      ? {
          setupId: record.setupId,
          deviceId,
          ...(deviceName ? { deviceName } : {}),
          access: resolvePairingSetupAccess(record.profile),
          completedAtMs: params.completedAtMs,
          deliveryState: "uncertain",
          retainUntilMs: params.retainUntilMs,
        }
      : undefined;

    // Cloud workers can retry an undelivered hello only with this exact bound bearer;
    // delivery confirmation retires it atomically with the confirmed completion.
    if (!completion || record.profile?.purpose !== "cloud-worker") {
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("device_bootstrap_tokens").where("token_key", "=", tokenRow.token_key),
      );
    }
    if (completion) {
      if (record.profile?.purpose === "cloud-worker") {
        params.recordWorkerEnvironment(
          bindCloudWorkerSetupCompletion({
            db,
            completion,
            credentialDigest: sha256Base64Url(tokenRow.token),
          }),
        );
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("device_pair_setup_completions")
          .where((eb) =>
            eb.or([
              eb("retain_until_ms", "<=", params.retentionNowMs),
              eb("setup_id", "=", completion.setupId),
            ]),
          ),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("device_pair_setup_completions").values({
          setup_id: completion.setupId,
          device_id: completion.deviceId,
          device_name: completion.deviceName ?? null,
          access: completion.access,
          completed_at_ms: completion.completedAtMs,
          delivery_state: completion.deliveryState,
          retain_until_ms: completion.retainUntilMs,
        }),
      );
    }
    return { record, ...(completion ? { completion } : {}) };
  }, resolveDevicePairingStateDbOptions());
}

/** Mark one consumed setup handoff as delivered without reviving an expired or replaced row. */
export function confirmDevicePairSetupCompletionDeliveryInTransaction(params: {
  setupId: string;
  deviceId: string;
  nowMs: number;
}): DevicePairSetupCompletionRecord | null {
  const setupId = params.setupId.trim();
  const deviceId = params.deviceId.trim();
  if (!setupId || !deviceId) {
    return null;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    ensureDevicePairSetupCompletionSchema(db);
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .updateTable("device_pair_setup_completions")
        .set({ delivery_state: "confirmed" })
        .where("setup_id", "=", setupId)
        .where("device_id", "=", deviceId)
        .where("retain_until_ms", ">", params.nowMs)
        .returningAll(),
    );
    if (!row) {
      return null;
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("device_bootstrap_tokens")
        .where("setup_id", "=", setupId)
        .where("device_id", "=", deviceId),
    );
    return fromSetupCompletionRow(row);
  }, resolveDevicePairingStateDbOptions());
}

/** The host retains this deadline until a shared-state writer receipt changes. */
export function readDevicePairSetupCompletionExpiryInDatabase(
  db: EngineConnection,
): number | undefined {
  if (!tableExists(db, "device_pair_setup_completions")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .selectFrom("device_pair_setup_completions")
      .select("retain_until_ms")
      .orderBy("retain_until_ms", "asc")
      .limit(1),
  )?.retain_until_ms;
}

/** The maintenance command owns the write transaction and its live admission. */
export function pruneExpiredDevicePairSetupCompletionsInDatabase(
  db: EngineConnection,
  nowMs: number,
): number {
  if (!tableExists(db, "device_pair_setup_completions")) {
    return 0;
  }
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
      .deleteFrom("device_pair_setup_completions")
      .where("retain_until_ms", "<=", nowMs),
  );
  return Number(result.numAffectedRows ?? 0);
}

/** Prune elapsed setup completions, then read one live record. */
export function loadDevicePairSetupCompletionRecord(
  setupId: string,
  nowMs: number,
  baseDir?: string,
): DevicePairSetupCompletionRecord | null {
  const databaseOptions = resolveDevicePairingStateDbOptions(baseDir);
  const database = openOpenClawStateDatabase(databaseOptions);
  ensureDevicePairSetupCompletionSchema(database.db);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("device_pair_setup_completions").where("retain_until_ms", "<=", nowMs),
      );
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("device_pair_setup_completions")
          .selectAll()
          .where("setup_id", "=", setupId),
      );
      return row ? fromSetupCompletionRow(row) : null;
    },
    { ...databaseOptions, database },
  );
}
