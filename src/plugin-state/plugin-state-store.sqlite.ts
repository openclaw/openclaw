// Plugin state SQLite helpers persist plugin state in the OpenClaw state database.
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  runWriteTransaction,
  withPluginStateDatabaseReadOnly,
  wrapPluginStateError,
} from "./plugin-state-store.database.js";
import {
  resolvePluginStateExpiresAtMs,
  parseStoredJson,
  getPluginStateKysely,
  bindPluginStateEntry,
  upsertPluginStateEntry,
  selectPluginStateEntry,
  selectPluginStateEntriesInKeyRange,
  deletePluginStateEntry,
  deleteExpiredPluginStateEntries,
  countLivePluginStateNamespaceEntries,
  lookupPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  registerPluginStateEntryIfAbsent,
} from "./plugin-state-store.mutations.js";
import {
  listPluginStateEntries,
  lookupPluginStateEntries,
  validatePluginStateKeyRange,
  type PluginStateKeyRangeParams,
} from "./plugin-state-store.reads.js";
import {
  assertCanInsertPluginStateEntry,
  countLivePluginStateEntries,
  enforcePostRegisterLimits,
  readPluginStateRetention,
  registerPluginStateEntry,
  type PluginStateRegisterEntryParams,
} from "./plugin-state-store.retention.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateOverflowPolicy,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

export { MAX_PLUGIN_STATE_VALUE_BYTES } from "./plugin-state-store.kernel.js";
export const MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES = 512;
export const PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS = 500;

export type PluginDoctorRawStateEntry = Omit<PluginStateEntry<unknown>, "value" | "expiresAt"> & {
  valueJson: string;
  value?: unknown;
  expiresAt: number | null;
};

function envOptions(env?: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function readPluginState<T>(
  operation: PluginStateStoreOperation,
  message: string,
  read: (store: PluginStateDatabase) => T,
  env?: NodeJS.ProcessEnv,
): T | undefined {
  const pathname = resolveOpenClawStateSqlitePath(env ?? process.env);
  try {
    return withPluginStateDatabaseReadOnly(operation, read, envOptions(env));
  } catch (error) {
    throw wrapPluginStateError(error, operation, "PLUGIN_STATE_READ_FAILED", message, pathname);
  }
}

function writePluginState<T>(
  operation: PluginStateStoreOperation,
  message: string,
  write: (store: PluginStateDatabase) => T,
  env?: NodeJS.ProcessEnv,
): T {
  try {
    return runWriteTransaction(operation, write, envOptions(env));
  } catch (error) {
    throw wrapPluginStateError(
      error,
      operation,
      operation === "consume" ? "PLUGIN_STATE_READ_FAILED" : "PLUGIN_STATE_WRITE_FAILED",
      message,
    );
  }
}

type PluginStateRegisterParams = PluginStateRegisterEntryParams & { env?: NodeJS.ProcessEnv };

export function pluginStateRegister(params: PluginStateRegisterParams): void {
  writePluginState(
    "register",
    "Failed to register plugin state entry.",
    (store) => registerPluginStateEntry(store, params),
    params.env,
  );
}

/** Prepared doctor rows only: validation and plugin-owned accessors run before BEGIN. */
export function pluginStateImportBatch(
  params: Pick<
    PluginStateRegisterParams,
    "pluginId" | "namespace" | "maxEntries" | "overflowPolicy" | "env"
  >,
  entries: readonly Pick<
    PluginStateRegisterParams,
    "key" | "valueJson" | "createdAtMs" | "ttlMs"
  >[],
): void {
  if (entries.length === 0) {
    return;
  }
  if (entries.length > PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS) {
    throw new RangeError("Plugin state doctor import batch exceeds its row limit");
  }
  try {
    const result = runWriteTransaction(
      "register",
      (store): Result<void, unknown> => {
        const retention = readPluginStateRetention(store.db, { ...params, now: Date.now() });
        for (const entry of entries) {
          try {
            // A row can evict before failing. Roll back only that row, then commit
            // the successful prefix before reporting failure so Doctor can resume.
            runSqliteImmediateTransactionSync(store.db, () =>
              registerPluginStateEntry(store, { ...params, ...entry }, retention),
            );
          } catch (error) {
            // Only a surviving outer transaction can commit its prefix. Lost
            // savepoints close the handle; corruption must still reach its owner.
            if (!store.db.isOpen || !store.db.isTransaction || isSqliteCorruptionError(error)) {
              throw error;
            }
            return err(error);
          }
        }
        return ok(undefined);
      },
      envOptions(params.env),
    );
    if (!result.ok) {
      throw result.error;
    }
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateRegisterIfAbsent(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return writePluginState(
    "register",
    "Failed to register plugin state entry.",
    (store) => registerPluginStateEntryIfAbsent(store, params),
    params.env,
  );
}

export function pluginStateUpdate(params: {
  pluginId: string;
  namespace: string;
  key: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  updateValueJson: (current: unknown) => { valueJson: string; ttlMs?: number } | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return writePluginState(
    "register",
    "Failed to update plugin state entry.",
    (store) => {
      const now = Date.now();
      deleteExpiredPluginStateEntries(store.db, now, {
        pluginId: params.pluginId,
        namespace: params.namespace,
      });
      const existing = selectPluginStateEntry(store.db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        key: params.key,
        now,
      });
      const next = params.updateValueJson(
        existing ? parseStoredJson(existing.value_json, "lookup", store.path) : undefined,
      );
      if (!next) {
        return false;
      }
      if (!existing) {
        assertCanInsertPluginStateEntry({
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
        });
      }
      const expiresAt = resolvePluginStateExpiresAtMs({
        ttlMs: next.ttlMs,
        namespace: params.namespace,
        now,
        operation: "register",
        path: store.path,
      });
      upsertPluginStateEntry(
        store.db,
        bindPluginStateEntry({
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          valueJson: next.valueJson,
          createdAt: now,
          expiresAt,
        }),
      );
      enforcePostRegisterLimits({
        store,
        pluginId: params.pluginId,
        namespace: params.namespace,
        maxEntries: params.maxEntries,
        overflowPolicy: params.overflowPolicy,
        now,
        protectedKey: params.key,
      });
      return true;
    },
    params.env,
  );
}

export function pluginStateLookup(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): unknown {
  return readPluginState(
    "lookup",
    "Failed to read plugin state entry.",
    (store) => lookupPluginStateEntry(store, params),
    params.env,
  );
}

export function pluginStateLookupMany(params: {
  pluginId: string;
  namespace: string;
  keys: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Array<Result<unknown, PluginStateStoreError>> {
  if (params.keys.length === 0) {
    return [];
  }
  return (
    readPluginState(
      "lookup",
      "Failed to read plugin state entries.",
      (store) => lookupPluginStateEntries(store, params),
      params.env,
    ) ?? params.keys.map(() => ok(undefined))
  );
}

export function pluginStateConsume(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): unknown {
  return writePluginState(
    "consume",
    "Failed to consume plugin state entry.",
    (store) => consumePluginStateEntry(store, params),
    params.env,
  );
}

export function pluginStateDelete(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return writePluginState(
    "delete",
    "Failed to delete plugin state entry.",
    ({ db }) => {
      return deletePluginStateEntry(db, params) > 0;
    },
    params.env,
  );
}

export function pluginStateDeleteIf(params: {
  pluginId: string;
  namespace: string;
  key: string;
  predicate: (current: unknown) => boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return writePluginState(
    "delete",
    "Failed to conditionally delete plugin state entry.",
    ({ db, path: databasePath }) => {
      const row = selectPluginStateEntry(db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        key: params.key,
        now: Date.now(),
      });
      if (!row || !params.predicate(parseStoredJson(row.value_json, "delete", databasePath))) {
        return false;
      }
      return deletePluginStateEntry(db, params) > 0;
    },
    params.env,
  );
}

/** Deletes one bounded set of exact observed rows in a single synchronous transaction. */
export function pluginStateDeleteEntriesIfUnchanged(params: {
  pluginId: string;
  namespace: string;
  entries: readonly PluginDoctorRawStateEntry[];
  assertOwnedInTransaction: (database: DatabaseSync) => void;
  env?: NodeJS.ProcessEnv;
}): { deleted: number; changed: number } {
  if (params.entries.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES) {
    throw new RangeError(
      `Plugin state bulk deletion cannot exceed ${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES} entries.`,
    );
  }
  if (params.entries.length === 0) {
    return { deleted: 0, changed: 0 };
  }
  // Copy plugin-visible envelopes before BEGIN; no plugin-owned accessors run in the transaction.
  const observed = params.entries.map(({ value: _value, ...entry }) => entry);
  return runWriteTransaction(
    "delete",
    ({ db }) => {
      params.assertOwnedInTransaction(db);
      let deleted = 0;
      for (const entry of observed) {
        let query = getPluginStateKysely(db)
          .deleteFrom("plugin_state_entries")
          .where("plugin_id", "=", params.pluginId)
          .where("namespace", "=", params.namespace)
          .where("entry_key", "=", entry.key)
          .where("value_json", "=", entry.valueJson)
          .where("created_at", "=", entry.createdAt);
        query =
          entry.expiresAt === null
            ? query.where("expires_at", "is", null)
            : query.where("expires_at", "=", entry.expiresAt);
        deleted += Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0);
      }
      return { deleted, changed: observed.length - deleted };
    },
    envOptions(params.env),
  );
}

/** Doctor-only bounded raw read keeps malformed rows visible and preserves exact CAS bytes. */
export function pluginStateDoctorEntriesInKeyRange(params: {
  pluginId: string;
  namespace: string;
  prefix: string;
  after?: string;
  limit: number;
  env?: NodeJS.ProcessEnv;
}): PluginDoctorRawStateEntry[] {
  if (
    !params.prefix ||
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES ||
    (params.after !== undefined && !params.after.startsWith(params.prefix))
  ) {
    throw new RangeError(
      `Plugin doctor state reads require a valid prefix and a limit of 1-${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES}.`,
    );
  }
  return readPluginStateRowsInKeyRange(
    {
      ...params,
      keyStartInclusive: params.after === undefined ? params.prefix : `${params.after}\0`,
      keyEndExclusive: `${params.prefix}\uffff`,
    },
    (row): PluginDoctorRawStateEntry => {
      const createdAt = normalizeSqliteNumber(row.created_at);
      const expiresAt = normalizeSqliteNumber(row.expires_at);
      const entry: PluginDoctorRawStateEntry = {
        key: row.entry_key,
        valueJson: row.value_json,
        createdAt: createdAt ?? 0,
        expiresAt: expiresAt ?? null,
      };
      if (
        !Number.isSafeInteger(createdAt) ||
        (createdAt ?? -1) < 0 ||
        (row.expires_at !== null && !Number.isSafeInteger(expiresAt))
      ) {
        return entry;
      }
      try {
        entry.value = JSON.parse(row.value_json) as unknown;
      } catch {
        // Keep corrupt rows in the page so Doctor can advance past them safely.
      }
      return entry;
    },
  );
}

export function pluginStateCount(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): number {
  return (
    readPluginState(
      "count",
      "Failed to count plugin state entries.",
      ({ db }) =>
        countLivePluginStateNamespaceEntries(db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          now: Date.now(),
        }),
      params.env,
    ) ?? 0
  );
}

export function pluginStateEntries(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginStateEntry<unknown>[] {
  return (
    readPluginState(
      "entries",
      "Failed to list plugin state entries.",
      (store) => listPluginStateEntries(store, params),
      params.env,
    ) ?? []
  );
}

function readPluginStateRowsInKeyRange<T>(
  params: PluginStateKeyRangeParams & { env?: NodeJS.ProcessEnv },
  mapRow: (row: PluginStateReadRow, databasePath: string) => T,
): T[] {
  validatePluginStateKeyRange(params);
  return (
    readPluginState(
      "entries",
      "Failed to list plugin state entries by key range.",
      ({ db, path: databasePath }) =>
        selectPluginStateEntriesInKeyRange(db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          keyStartInclusive: params.keyStartInclusive,
          keyEndExclusive: params.keyEndExclusive,
          limit: params.limit,
          order: params.order ?? "asc",
          now: Date.now(),
        }).map((row) => mapRow(row, databasePath)),
      params.env,
    ) ?? []
  );
}

export function pluginStateClear(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): void {
  writePluginState(
    "clear",
    "Failed to clear plugin state namespace.",
    ({ db }) => clearPluginStateNamespace(db, params),
    params.env,
  );
}

export function getPluginStateCapacity(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
): { liveEntries: number; maxEntries: number } {
  return {
    liveEntries:
      readPluginState(
        "entries",
        "Failed to count plugin state entries.",
        ({ db }) => countLivePluginStateEntries(db, { pluginId, now: Date.now() }),
        env,
      ) ?? 0,
    // Doctor's capacity contract remains available; keyed state has no aggregate row quota.
    maxEntries: Number.POSITIVE_INFINITY,
  };
}

export function closePluginStateDatabase(): void {
  closeOpenClawStateDatabase();
}

export async function closePluginStateDatabaseAsync(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
}
