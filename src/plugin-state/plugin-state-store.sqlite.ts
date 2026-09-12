// Plugin state SQLite helpers persist plugin state in the OpenClaw state database.
import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQuerySync, sqliteStringSet } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  hasOpenClawStateTablesBeyondStartupCheckpoint,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createPluginStateError,
  resolvePluginStateExpiresAtMs,
  parseStoredJson,
  rowToEntry,
  getPluginStateKysely,
  bindPluginStateEntry,
  upsertPluginStateEntry,
  insertPluginStateEntryIfAbsent,
  selectPluginStateEntry,
  iteratePluginStateEntries,
  selectPluginStateEntriesInKeyRange,
  deletePluginStateEntry,
  deleteExpiredPluginStateEntries,
  allocatePluginStateNamespaceCreatedAt,
  countLivePluginStateEntries,
  readPluginStateRetention,
  enforcePostRegisterLimits,
  assertCanInsertPluginStateEntry,
  registerPluginStateEntry,
  lookupPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateRegisterEntryParams,
  type PluginStateRow,
} from "./plugin-state-store.kernel.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateOverflowPolicy,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
  type PluginStateStoreProbeResult,
  type PluginStateStoreProbeStep,
} from "./plugin-state-store.types.js";

// Plugin-wide fuse only; namespace maxEntries still owns normal cache eviction.
export const MAX_PLUGIN_STATE_VALUE_BYTES = 1_048_576;
const MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN = 50_000;
export const MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES = 512;
export const PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS = 500;
let maxPluginStateEntriesPerPluginForTests: number | undefined;

export type PluginDoctorRawStateEntry = Omit<PluginStateEntry<unknown>, "value" | "expiresAt"> & {
  valueJson: string;
  value?: unknown;
  expiresAt: number | null;
};

type PluginStateSeedEntryForTests = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  createdAt?: number;
  expiresAt?: number | null;
};

function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
  pathname = resolveOpenClawStateSqlitePath(process.env),
): PluginStateStoreError {
  if (error instanceof PluginStateStoreError) {
    return error;
  }
  let publicMessage = message;
  // Only owner-classified failures get public hints. Cause messages can contain
  // database paths, SQL, or stored values and must stay out of this message.
  if (fallbackCode === "PLUGIN_STATE_OPEN_FAILED") {
    if (isSqliteSchemaVersionError(error)) {
      publicMessage +=
        "\nThe state database uses a newer schema. Run an OpenClaw build that supports it.";
    } else if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      publicMessage +=
        "\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.";
    }
  }
  return createPluginStateError({
    code: fallbackCode,
    operation,
    message: publicMessage,
    path: pathname,
    cause: error,
  });
}

function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
  options: OpenClawStateDatabaseOptions = {},
): PluginStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveOpenClawStateSqlitePath(env);
  try {
    return openOpenClawStateDatabase(options);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      operation,
      "PLUGIN_STATE_OPEN_FAILED",
      "Failed to open the plugin state database.",
      pathname,
    );
  }
}

function isMissingPluginStateTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    error.message === "no such table: plugin_state_entries"
  );
}

/** Read plugin state without joining the shared writable database lifecycle. */
function withPluginStateDatabaseReadOnly<T>(
  operationName: PluginStateStoreOperation,
  operation: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveOpenClawStateSqlitePath(options.env ?? process.env);
  let operationStarted = false;
  try {
    return withExistingOpenClawStateDatabaseReadOnly(({ db, path }) => {
      operationStarted = true;
      try {
        return operation({ db, path });
      } catch (error) {
        if (isMissingPluginStateTableError(error)) {
          // The lease bootstrap creates exactly schema_meta + state_leases before the first write;
          // any other table means the missing plugin-state table is damage, not fresh state.
          if (!hasOpenClawStateTablesBeyondStartupCheckpoint(db)) {
            return undefined;
          }
        }
        throw error;
      }
    }, options);
  } catch (error) {
    if (!operationStarted) {
      throw wrapPluginStateError(
        error,
        operationName,
        "PLUGIN_STATE_OPEN_FAILED",
        "Failed to open the plugin state database.",
        pathname,
      );
    }
    throw error;
  }
}

function envOptions(env?: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  // Only cold acquisition failures are open errors. A held owner's ownership or
  // transaction failure must remain a write error, with its callback supplying the handle.
  if (!isOpenClawStateDatabaseOpen(resolveOpenClawStateSqlitePath(options.env ?? process.env))) {
    openPluginStateDatabase(operation, options);
  }
  return runOpenClawStateWriteTransaction(write, options);
}

export function resolveMaxPluginStateEntriesPerPlugin(): number {
  return maxPluginStateEntriesPerPluginForTests ?? MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN;
}

type PluginStateRegisterParams = PluginStateRegisterEntryParams & { env?: NodeJS.ProcessEnv };

export function pluginStateRegister(params: PluginStateRegisterParams): void {
  try {
    runWriteTransaction(
      "register",
      (store) => registerPluginStateEntry(store, params, resolveMaxPluginStateEntriesPerPlugin()),
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
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
              registerPluginStateEntry(
                store,
                { ...params, ...entry },
                resolveMaxPluginStateEntriesPerPlugin(),
                retention,
              ),
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

export function pluginStateRegisterSequencedJournalEntry(params: {
  pluginId: string;
  cursorNamespace: string;
  cursorKey: string;
  cursorMaxEntries: number;
  journalNamespace: string;
  journalMaxEntries: number;
  journalKeyRange: {
    keyStartInclusive: string;
    keyEndExclusive: string;
    valueKind?: string;
  };
  readCursorSequence: (valueJson: string) => number | undefined;
  prepareEntry: (sequence: number) => {
    cursorValueJson: string;
    journalKey: string;
    journalValueJson: string;
  };
  env?: NodeJS.ProcessEnv;
}): number {
  try {
    return runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
        });
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
        });
        const cursor = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
          key: params.cursorKey,
          now,
        });
        const cursorSequence = cursor ? params.readCursorSequence(cursor.value_json) : undefined;
        // Cursor eviction must not let an admitted append reuse a retained sequence.
        const tail = selectPluginStateEntriesInKeyRange(store.db, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          ...params.journalKeyRange,
          limit: 1,
          order: "desc",
          now,
        })[0];
        let retainedSequence = 0;
        if (tail) {
          const value = parseStoredJson(tail.value_json, "entries", store.path);
          if (value === null) {
            throw new TypeError("Plugin state journal tail must not be null.");
          }
          if (
            typeof value === "object" &&
            (params.journalKeyRange.valueKind === undefined ||
              ("kind" in value && value.kind === params.journalKeyRange.valueKind))
          ) {
            retainedSequence = Math.max(0, Number("sequence" in value ? (value.sequence ?? 0) : 0));
            if (!Number.isSafeInteger(retainedSequence)) {
              throw createPluginStateError({
                code: "PLUGIN_STATE_INVALID_INPUT",
                operation: "register",
                message: "Plugin state journal sequence must be a safe non-negative integer.",
              });
            }
          }
        }
        const lastSequence = Math.max(retainedSequence, cursorSequence ?? 0);
        const sequence = lastSequence + 1;
        if (!Number.isSafeInteger(sequence)) {
          throw new RangeError("Plugin state journal sequence exhausted safe integer range");
        }
        const prepared = params.prepareEntry(sequence);
        if (
          prepared.journalKey < params.journalKeyRange.keyStartInclusive ||
          prepared.journalKey >= params.journalKeyRange.keyEndExclusive
        ) {
          throw createPluginStateError({
            code: "PLUGIN_STATE_INVALID_INPUT",
            operation: "register",
            message: "Plugin state journal key must be inside its retained key range.",
          });
        }
        const existingJournalEntry = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          key: prepared.journalKey,
          now,
        });
        if (existingJournalEntry) {
          throw createPluginStateError({
            code: "PLUGIN_STATE_WRITE_FAILED",
            operation: "register",
            message: "Plugin state journal sequence already exists.",
            path: store.path,
          });
        }
        if (!cursor) {
          assertCanInsertPluginStateEntry({
            maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
            store,
            pluginId: params.pluginId,
            namespace: params.cursorNamespace,
            maxEntries: params.cursorMaxEntries,
            overflowPolicy: "evict-oldest",
            now,
          });
        }
        assertCanInsertPluginStateEntry({
          maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
          store,
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          maxEntries: params.journalMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
        });
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.cursorNamespace,
            key: params.cursorKey,
            valueJson: prepared.cursorValueJson,
            createdAt: now,
            expiresAt: null,
          }),
        );
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
          maxEntries: params.cursorMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
          protectedKey: params.cursorKey,
          maxPluginEntries: undefined,
        });
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.journalNamespace,
            key: prepared.journalKey,
            valueJson: prepared.journalValueJson,
            createdAt: allocatePluginStateNamespaceCreatedAt(store.db, {
              pluginId: params.pluginId,
              namespace: params.journalNamespace,
              now,
            }),
            expiresAt: null,
          }),
        );
        enforcePostRegisterLimits({
          maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
          store,
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          maxEntries: params.journalMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
          protectedKey: prepared.journalKey,
        });
        return sequence;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register sequenced plugin state journal entry.",
    );
  }
}

export function pluginStateRegisterIfAbsent(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        const expiresAt = resolvePluginStateExpiresAtMs({
          ttlMs: params.ttlMs,
          now,
          operation: "register",
          path: store.path,
        });
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
        if (existing) {
          return false;
        }
        // The exact expired key can lie beyond this namespace's cleanup batch.
        // Reclaim it inside the same authoritative transaction before insertion.
        deletePluginStateEntry(store.db, params);
        assertCanInsertPluginStateEntry({
          maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
        });
        const inserted = insertPluginStateEntryIfAbsent(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.namespace,
            key: params.key,
            valueJson: params.valueJson,
            createdAt: now,
            expiresAt,
          }),
        );
        if (!inserted) {
          return false;
        }
        enforcePostRegisterLimits({
          maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
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
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateUpdate(params: {
  pluginId: string;
  namespace: string;
  key: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  updateValueJson: (current: unknown) => { valueJson: string; ttlMs?: number } | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "register",
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
            maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
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
          maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
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
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to update plugin state entry.",
    );
  }
}

export function pluginStateLookup(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): unknown {
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return withPluginStateDatabaseReadOnly(
      "lookup",
      (store) => lookupPluginStateEntry(store, params),
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "lookup",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to read plugin state entry.",
      pathname,
    );
  }
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
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "lookup",
        ({ db, path: databasePath }) => {
          const now = Date.now();
          const rows = executeSqliteQuerySync(
            db,
            getPluginStateKysely(db)
              .selectFrom("plugin_state_entries")
              .select(["entry_key", "value_json"])
              .where("plugin_id", "=", params.pluginId)
              .where("namespace", "=", params.namespace)
              .where("entry_key", "in", sqliteStringSet(params.keys))
              .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)])),
          ).rows;
          const values = new Map(rows.map((row) => [row.entry_key, row.value_json]));
          return params.keys.map((key): Result<unknown, PluginStateStoreError> => {
            // Match node:sqlite text binding, including lone UTF-16 surrogates.
            const raw = values.get(toUSVString(key));
            try {
              return ok(
                raw === undefined ? undefined : parseStoredJson(raw, "lookup", databasePath),
              );
            } catch (error) {
              // Let ordered readers stop before a later corrupt value, just as with lookup.
              if (error instanceof PluginStateStoreError && error.code === "PLUGIN_STATE_CORRUPT") {
                return err(error);
              }
              throw error;
            }
          });
        },
        envOptions(params.env),
      ) ?? params.keys.map(() => ok(undefined))
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "lookup",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to read plugin state entries.",
      pathname,
    );
  }
}

export function pluginStateConsume(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): unknown {
  try {
    return runWriteTransaction(
      "consume",
      (store) => {
        const row = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now: Date.now(),
        });
        if (!row) {
          return undefined;
        }
        deletePluginStateEntry(store.db, params);
        return parseStoredJson(row.value_json, "consume", store.path);
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "consume",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to consume plugin state entry.",
    );
  }
}

export function pluginStateDelete(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "delete",
      ({ db }) => {
        return deletePluginStateEntry(db, params) > 0;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "delete",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to delete plugin state entry.",
    );
  }
}

export function pluginStateDeleteIf(params: {
  pluginId: string;
  namespace: string;
  key: string;
  predicate: (current: unknown) => boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "delete",
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
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "delete",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to conditionally delete plugin state entry.",
    );
  }
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

export function pluginStateEntries(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginStateEntry<unknown>[] {
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
        ({ db, path: databasePath }) => {
          const rows = iteratePluginStateEntries(db, {
            pluginId: params.pluginId,
            namespace: params.namespace,
            now: Date.now(),
          });
          const entries: PluginStateEntry<unknown>[] = [];
          let decodeFailure: { error: unknown } | undefined;
          for (const row of rows) {
            if (decodeFailure) {
              continue;
            }
            try {
              entries.push(rowToEntry(row, "entries", databasePath));
            } catch (error) {
              // Finish the SQL read so a later step failure still precedes JSON errors.
              decodeFailure = { error };
            }
          }
          if (decodeFailure) {
            throw decodeFailure.error;
          }
          return entries;
        },
        envOptions(params.env),
      ) ?? []
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries.",
      pathname,
    );
  }
}

/** Internal bounded key-range read for core owners with sortable plugin-state keys. */
type PluginStateKeyRangeParams = {
  pluginId: string;
  namespace: string;
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
  env?: NodeJS.ProcessEnv;
};

export function pluginStateEntriesInKeyRange(
  params: PluginStateKeyRangeParams,
): PluginStateEntry<unknown>[] {
  return readPluginStateRowsInKeyRange(params, (row, databasePath) =>
    rowToEntry(row, "entries", databasePath),
  );
}

function readPluginStateRowsInKeyRange<T>(
  params: PluginStateKeyRangeParams,
  mapRow: (row: PluginStateRow, databasePath: string) => T,
): T[] {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key-range limit must be a positive safe integer.",
    });
  }
  if (params.keyStartInclusive >= params.keyEndExclusive) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key range must have an increasing exclusive upper bound.",
    });
  }
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
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
        envOptions(params.env),
      ) ?? []
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries by key range.",
      pathname,
    );
  }
}

export function pluginStateClear(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    runWriteTransaction(
      "clear",
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getPluginStateKysely(db)
            .deleteFrom("plugin_state_entries")
            .where("plugin_id", "=", params.pluginId)
            .where("namespace", "=", params.namespace),
        );
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "clear",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to clear plugin state namespace.",
    );
  }
}

export function sweepExpiredPluginStateEntries(): number {
  try {
    return runWriteTransaction("sweep", ({ db }) =>
      deleteExpiredPluginStateEntries(db, Date.now()),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "sweep",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to sweep expired plugin state entries.",
    );
  }
}

export function clearPluginStateDatabaseForTests(): void {
  const store = openPluginStateDatabase("clear");
  executeSqliteQuerySync(
    store.db,
    getPluginStateKysely(store.db).deleteFrom("plugin_state_entries"),
  );
}

function setMaxPluginStateEntriesPerPluginForTests(value?: number): void {
  maxPluginStateEntriesPerPluginForTests = value;
}

export function countPluginStateLiveEntries(pluginId: string, env?: NodeJS.ProcessEnv): number {
  const pathname = resolveOpenClawStateSqlitePath(env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
        ({ db }) => countLivePluginStateEntries(db, { pluginId, now: Date.now() }),
        envOptions(env),
      ) ?? 0
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to count plugin state entries.",
      pathname,
    );
  }
}

export function getPluginStateCapacity(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
): { liveEntries: number; maxEntries: number } {
  return {
    liveEntries: countPluginStateLiveEntries(pluginId, env),
    maxEntries: resolveMaxPluginStateEntriesPerPlugin(),
  };
}

function seedPluginStateDatabaseEntriesForTests(
  entries: readonly PluginStateSeedEntryForTests[],
): void {
  if (entries.length === 0) {
    return;
  }

  const now = Date.now();
  runWriteTransaction("register", (store) => {
    for (const [index, entry] of entries.entries()) {
      upsertPluginStateEntry(
        store.db,
        bindPluginStateEntry({
          pluginId: entry.pluginId,
          namespace: entry.namespace,
          key: entry.key,
          valueJson: entry.valueJson,
          createdAt: entry.createdAt ?? now + index,
          expiresAt: entry.expiresAt ?? null,
        }),
      );
    }
  });
}

function probePluginStateStore(): PluginStateStoreProbeResult {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  const steps: PluginStateStoreProbeStep[] = [];
  const stateWasOpen = isOpenClawStateDatabaseOpen();

  const pushOk = (name: string) => steps.push({ name, ok: true });
  const pushFailure = (name: string, error: unknown) => {
    const wrapped =
      error instanceof PluginStateStoreError
        ? error
        : createPluginStateError({
            code: "PLUGIN_STATE_OPEN_FAILED",
            operation: "probe",
            message: error instanceof Error ? error.message : String(error),
            path: databasePath,
            cause: error,
          });
    steps.push({ name, ok: false, code: wrapped.code, message: wrapped.message });
  };

  try {
    requireNodeSqlite();
    pushOk("load-sqlite");
  } catch (error) {
    pushFailure(
      "load-sqlite",
      createPluginStateError({
        code: "PLUGIN_STATE_SQLITE_UNAVAILABLE",
        operation: "load-sqlite",
        message: "SQLite support is unavailable for plugin state storage.",
        path: databasePath,
        cause: error,
      }),
    );
    return { ok: false, databasePath, steps };
  }

  try {
    openPluginStateDatabase("probe");
    pushOk("open");
    pushOk("schema");
    runWriteTransaction("probe", ({ db }) => {
      const now = Date.now();
      const expiresAt = resolvePluginStateExpiresAtMs({
        ttlMs: 60_000,
        now,
        operation: "probe",
        path: databasePath,
      });
      upsertPluginStateEntry(
        db,
        bindPluginStateEntry({
          pluginId: "core:plugin-state-probe",
          namespace: "diagnostics",
          key: "probe",
          valueJson: JSON.stringify({ ok: true }),
          createdAt: now,
          expiresAt,
        }),
      );
      selectPluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
        now,
      });
      deletePluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
      });
    });
    pushOk("write-read-delete");
    openOpenClawStateDatabase().walMaintenance.checkpoint();
    pushOk("checkpoint");
  } catch (error) {
    pushFailure("probe", error);
  } finally {
    if (!stateWasOpen) {
      closePluginStateDatabase();
    }
  }

  return { ok: steps.every((step) => step.ok), databasePath, steps };
}

export function closePluginStateDatabase(): void {
  closeOpenClawStateDatabase();
}

export async function closePluginStateDatabaseAsync(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.pluginStateSqliteTestApi")] = {
    probePluginStateStore,
    seedPluginStateDatabaseEntriesForTests,
    setMaxPluginStateEntriesPerPluginForTests,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
