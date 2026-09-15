// Plugin state store exposes persisted per-plugin state operations.
import type { Result } from "@openclaw/normalization-core/result";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { validatePluginStateComparison } from "./plugin-state-store.comparison.js";
import { preparePluginStateJournalValue } from "./plugin-state-store.journal.js";
import {
  validatePluginStateKeyRange,
  type PluginStateKeyRangeParams,
} from "./plugin-state-store.reads.js";
import {
  clearPluginStateDatabaseForTests,
  closePluginStateDatabase,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS,
  pluginStateImportBatch,
  pluginStateClear,
  pluginStateConsume,
  pluginStateCount,
  pluginStateDelete,
  pluginStateDeleteIf,
  pluginStateEntries,
  pluginStateLookup,
  pluginStateLookupMany,
  pluginStateRegister,
  pluginStateRegisterIfAbsent,
  pluginStateUpdate,
  resolveMaxPluginStateEntriesPerPlugin,
} from "./plugin-state-store.sqlite.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateSyncKeyedStore,
  PluginStateOverflowPolicy,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import {
  comparePluginStateDeleteInWorker,
  comparePluginStateUpdateInWorker,
  observePluginStateInWorker,
  clearPluginStateInWorker,
  consumePluginStateInWorker,
  countPluginStateInWorker,
  deletePluginStateIfEqualInWorker,
  deletePluginStateInWorker,
  listPluginStateInWorker,
  listPluginStateInKeyRangeInWorker,
  registerPluginStateJournalInWorker,
  lookupManyPluginStateInWorker,
  lookupPluginStateInWorker,
  registerPluginStateIfAbsentInWorker,
  registerPluginStateInWorker,
} from "./plugin-state-worker-client.js";
import {
  createPluginStoreOptionPolicy,
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
} from "./plugin-store-validation.js";

// Public plugin-state facade over the sqlite-backed store. It validates plugin
// ids, namespaces, JSON values, TTLs, and per-plugin limits before persistence.
export type {
  OpenKeyedStoreOptions,
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";

export type { PluginDoctorRawStateEntry } from "./plugin-state-store.sqlite.js";

export {
  closePluginStateDatabaseAsync,
  countPluginStateLiveEntries,
  getPluginStateCapacity,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  resolveMaxPluginStateEntriesPerPlugin,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.sqlite.js";

type StoreOptionSignature = {
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
};

type PreparedRegisterParams = {
  key: string;
  valueJson: string;
  ttlMs?: number;
};

type PluginStateImportEntry = {
  key: string;
  value: unknown;
  createdAt: number;
  ttlMs?: number;
};

function invalidInput(
  message: string,
  operation: PluginStateStoreOperation = "register",
): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation,
  });
}

function validateNamespace(value: string, operation: PluginStateStoreOperation = "open"): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function validateKey(value: string, operation: PluginStateStoreOperation = "register"): string {
  return validatePluginStoreKey({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput("plugin state maxEntries must be an integer >= 1", "open");
  }
  return value;
}

const optionPolicy = createPluginStoreOptionPolicy<StoreOptionSignature>({
  label: "plugin state",
  invalid: (message) => invalidInput(message, "open"),
});

function validateOptionalTtlMs(
  value: number | undefined,
  operation: PluginStateStoreOperation = "register",
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin state ttlMs",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function prepareRegisterParams(
  key: string,
  value: unknown,
  defaultTtlMs?: number,
  opts?: { ttlMs?: number },
): PreparedRegisterParams {
  const normalizedKey = validateKey(key, "register");
  const json = serializePluginStoreJson({
    value,
    label: "plugin state value",
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
    errors: {
      invalid: (message) => invalidInput(message, "register"),
      limit: (message) =>
        new PluginStateStoreError(message, {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
    },
  });
  const ttlMs = validateOptionalTtlMs(opts?.ttlMs, "register") ?? defaultTtlMs;
  return {
    key: normalizedKey,
    valueJson: json,
    ...(ttlMs != null ? { ttlMs } : {}),
  };
}

function prepareLookupKeys(keys: readonly string[]): string[] {
  if (keys.length > 10_000) {
    throw invalidInput("plugin state lookupMany accepts at most 10000 keys", "lookup");
  }
  return Array.from(keys, (key) => validateKey(key, "lookup"));
}

function createKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateKeyedStore<T>> {
  const prepared = prepareKeyedStoreOptions(pluginId, options);
  const store = createSyncKeyedStore<T>(prepared);
  const scope = { pluginId, namespace: prepared.namespace, env: prepared.env };

  return {
    observe: async (key) => {
      const observation = await observePluginStateInWorker({
        pluginId,
        namespace: prepared.namespace,
        key: validateKey(key, "lookup"),
        env: prepared.env,
      });
      // SAFETY: The namespace's JSON value type is caller-owned, as with lookup.
      return observation as PluginStateObservation<T>;
    },
    compareAndApply: async (key, comparison, intent) => {
      if (intent?.operation !== "update" && intent?.operation !== "delete") {
        throw invalidInput("Plugin state comparison requires an update or delete intent.");
      }
      const operation = intent.operation === "update" ? "register" : "delete";
      const normalizedKey = validateKey(key, operation);
      validatePluginStateComparison(comparison, operation);
      const common = {
        pluginId,
        namespace: prepared.namespace,
        key: normalizedKey,
        comparison,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
        maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
        env: prepared.env,
      };
      let result: PluginStateCompareResult<unknown>;
      if (intent.operation === "update" && intent.action === "set") {
        const next = prepareRegisterParams(normalizedKey, intent.value, prepared.defaultTtlMs, {
          ttlMs: intent.ttlMs,
        });
        result = await comparePluginStateUpdateInWorker({
          ...common,
          ...next,
          operation: "update",
          action: "set",
        });
      } else if (intent.operation === "update" && intent.action === "keep") {
        result = await comparePluginStateUpdateInWorker({
          ...common,
          operation: "update",
          action: "keep",
        });
      } else if (
        intent.operation === "delete" &&
        (intent.action === "delete" || intent.action === "keep")
      ) {
        result = await comparePluginStateDeleteInWorker({
          ...common,
          operation: "delete",
          action: intent.action,
        });
      } else {
        throw invalidInput("Plugin state comparison has an invalid mutation action.", operation);
      }
      // SAFETY: Conflicts return the same namespace JSON type exposed by observe and lookup.
      return result as PluginStateCompareResult<T>;
    },
    register: async (key, value, opts) => {
      const entry = prepareRegisterParams(key, value, prepared.defaultTtlMs, opts);
      await registerPluginStateInWorker({
        ...scope,
        ...entry,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
        maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
      });
    },
    registerIfAbsent: async (key, value, opts) => {
      const entry = prepareRegisterParams(key, value, prepared.defaultTtlMs, opts);
      return await registerPluginStateIfAbsentInWorker({
        pluginId,
        namespace: prepared.namespace,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
        env: prepared.env,
        ...entry,
        maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
      });
    },
    update: async (...args) => store.update(...args),
    deleteIf: async (...args) => store.deleteIf(...args),
    deleteIfEqual: async (key, expected) => {
      const normalizedKey = validateKey(key, "delete");
      if (expected !== null && !["string", "number", "boolean"].includes(typeof expected)) {
        throw invalidInput("plugin state conditional deletion requires a JSON scalar", "delete");
      }
      serializePluginStoreJson({
        value: expected,
        label: "plugin state comparison value",
        maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
        errors: {
          invalid: (message) => invalidInput(message, "delete"),
          limit: (message) => invalidInput(message, "delete"),
        },
      });
      return await deletePluginStateIfEqualInWorker({
        pluginId,
        namespace: prepared.namespace,
        key: normalizedKey,
        expected,
        env: prepared.env,
      });
    },
    lookup: async (key) => {
      const normalizedKey = validateKey(key, "lookup");
      // SAFETY: This namespace stores the caller's serialized JSON value type.
      return (await lookupPluginStateInWorker({ ...scope, key: normalizedKey })) as T | undefined;
    },
    lookupMany: async (keys) => {
      const normalizedKeys = prepareLookupKeys(keys);
      // SAFETY: Successful slots carry this namespace's caller-selected JSON value type.
      return (await lookupManyPluginStateInWorker({ ...scope, keys: normalizedKeys })) as Array<
        Result<T | undefined, PluginStateStoreError>
      >;
    },
    consume: async (key) => {
      const normalizedKey = validateKey(key, "consume");
      // SAFETY: The atomically consumed value has this namespace's caller-selected JSON type.
      return (await consumePluginStateInWorker({ ...scope, key: normalizedKey })) as T | undefined;
    },
    delete: async (key) => {
      const normalizedKey = validateKey(key, "delete");
      return await deletePluginStateInWorker({ ...scope, key: normalizedKey });
    },
    entries: async () => {
      // SAFETY: Entries come from this namespace and retain the caller's JSON value type.
      return (await listPluginStateInWorker(scope)) as PluginStateEntry<T>[];
    },
    count: async () => await countPluginStateInWorker(scope),
    clear: async () => {
      await clearPluginStateInWorker(scope);
    },
  };
}

function createSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateSyncKeyedStore<T>> {
  return createSyncKeyedStore<T>(prepareKeyedStoreOptions(pluginId, options));
}

function prepareKeyedStoreOptions(pluginId: string, options: OpenKeyedStoreOptions) {
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
  });
  return { pluginId, namespace, maxEntries, overflowPolicy, defaultTtlMs, env };
}

function createSyncKeyedStore<T>({
  pluginId,
  namespace,
  maxEntries,
  overflowPolicy,
  defaultTtlMs,
  env,
}: ReturnType<typeof prepareKeyedStoreOptions>): Required<PluginStateSyncKeyedStore<T>> {
  return {
    register(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      pluginStateRegister({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    registerIfAbsent(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      return pluginStateRegisterIfAbsent({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return pluginStateUpdate({
        pluginId,
        namespace,
        key: normalizedKey,
        maxEntries,
        overflowPolicy,
        updateValueJson: (current) => {
          const next = updateValue(current as T | undefined);
          if (next === undefined) {
            return undefined;
          }
          const params = prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts);
          return {
            valueJson: params.valueJson,
            ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
          };
        },
        ...(env ? { env } : {}),
      });
    },
    deleteIf(key, predicate) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDeleteIf({
        pluginId,
        namespace,
        key: normalizedKey,
        predicate: (current) => predicate(current as T),
        ...(env ? { env } : {}),
      });
    },
    lookup(key) {
      const normalizedKey = validateKey(key, "lookup");
      return pluginStateLookup({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    lookupMany(keys) {
      const normalizedKeys = prepareLookupKeys(keys);
      const values = pluginStateLookupMany({
        pluginId,
        namespace,
        keys: normalizedKeys,
        ...(env ? { env } : {}),
      });
      // SAFETY: This namespace uses the caller's JSON value type, as with lookup.
      return values as Array<Result<T | undefined, PluginStateStoreError>>;
    },
    consume(key) {
      const normalizedKey = validateKey(key, "consume");
      return pluginStateConsume({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    delete(key) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDelete({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      });
    },
    entries() {
      return pluginStateEntries({
        pluginId,
        namespace,
        ...(env ? { env } : {}),
      }) as PluginStateEntry<T>[];
    },
    count() {
      return pluginStateCount({ pluginId, namespace, ...(env ? { env } : {}) });
    },
    clear() {
      pluginStateClear({ pluginId, namespace, ...(env ? { env } : {}) });
    },
  };
}

/**
 * Migration-only write path that preserves a legacy entry's original creation
 * timestamp. Cap eviction removes the oldest `created_at` first, so imported
 * rows must keep their real age instead of being stamped with the import time
 * (which would let later live writes evict fresher pre-existing rows first).
 * Not part of the plugin-facing store API.
 */
export function registerMigratedPluginStateEntry(params: {
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy?: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
  key: string;
  value: unknown;
  ttlMs?: number;
  createdAtMs: number;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!Number.isFinite(params.createdAtMs) || params.createdAtMs < 0) {
    throw invalidInput("plugin state migration createdAtMs must be a non-negative finite number");
  }
  const namespace = validateNamespace(params.namespace, "register");
  const maxEntries = validateMaxEntries(params.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(params.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(params.defaultTtlMs);
  const prepared = prepareRegisterParams(
    params.key,
    params.value,
    defaultTtlMs,
    params.ttlMs != null ? { ttlMs: params.ttlMs } : undefined,
  );
  pluginStateRegister({
    pluginId: params.pluginId,
    namespace,
    key: prepared.key,
    valueJson: prepared.valueJson,
    maxEntries,
    overflowPolicy,
    createdAtMs: Math.floor(params.createdAtMs),
    ...(params.env ? { env: params.env } : {}),
    ...(prepared.ttlMs != null ? { ttlMs: prepared.ttlMs } : {}),
  });
}

/** Opens an async plugin-state namespace for a non-core plugin id. */
export function createPluginStateKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options);
}

/**
 * Named adapter for the plugin-state-sync-keyed-store compatibility contract.
 * @deprecated Plugin runtimes should use api.runtime.state.openKeyedStore and
 * await its operations. This sync adapter remains through the next Plugin SDK major.
 */
export function createPluginStateSyncKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateSyncKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createSyncKeyedStoreForPluginId<T>(pluginId, options);
}

/** Atomically allocates a workspace sequence and appends one journal entry. */
export async function registerPluginStateSequencedJournalEntry(params: {
  pluginId: string;
  cursorOptions: OpenKeyedStoreOptions;
  cursorKey: string;
  journalOptions: OpenKeyedStoreOptions;
  /** This owner adds a fixed-width sequence suffix so key order matches append order. */
  journalKeyPrefix: string;
  journalKeyRange: {
    keyStartInclusive: string;
    keyEndExclusive: string;
    valueKind?: string;
  };
  journalValue: Record<string, unknown>;
}): Promise<number> {
  if (params.pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const journalKeyPrefix = validateKey(params.journalKeyPrefix);
  if (params.journalKeyRange.keyStartInclusive >= params.journalKeyRange.keyEndExclusive) {
    throw invalidInput("Plugin state key range must have an increasing exclusive upper bound.");
  }
  const cursorNamespace = validateNamespace(params.cursorOptions.namespace);
  const cursorMaxEntries = validateMaxEntries(params.cursorOptions.maxEntries);
  const cursorOverflowPolicy = optionPolicy.resolveOverflowPolicy(
    params.cursorOptions.overflowPolicy,
  );
  const cursorDefaultTtlMs = validateOptionalTtlMs(params.cursorOptions.defaultTtlMs);
  const journalNamespace = validateNamespace(params.journalOptions.namespace);
  const journalMaxEntries = validateMaxEntries(params.journalOptions.maxEntries);
  const journalOverflowPolicy = optionPolicy.resolveOverflowPolicy(
    params.journalOptions.overflowPolicy,
  );
  const journalDefaultTtlMs = validateOptionalTtlMs(params.journalOptions.defaultTtlMs);
  if (
    cursorOverflowPolicy !== "evict-oldest" ||
    journalOverflowPolicy !== "evict-oldest" ||
    cursorDefaultTtlMs !== undefined ||
    journalDefaultTtlMs !== undefined
  ) {
    throw invalidInput("sequenced plugin state journals require non-expiring evict-oldest stores");
  }
  if (params.cursorOptions.env !== params.journalOptions.env) {
    throw invalidInput("sequenced plugin state journal stores must share one environment");
  }
  const cursorKey = validateKey(params.cursorKey);
  optionPolicy.assertConsistent(params.pluginId, cursorNamespace, {
    maxEntries: cursorMaxEntries,
    overflowPolicy: cursorOverflowPolicy,
    defaultTtlMs: cursorDefaultTtlMs,
  });
  optionPolicy.assertConsistent(params.pluginId, journalNamespace, {
    maxEntries: journalMaxEntries,
    overflowPolicy: journalOverflowPolicy,
    defaultTtlMs: journalDefaultTtlMs,
  });
  const journalValueJson = preparePluginStateJournalValue(params.journalValue);
  return registerPluginStateJournalInWorker({
    pluginId: params.pluginId,
    cursorNamespace,
    cursorKey,
    cursorMaxEntries,
    journalNamespace,
    journalMaxEntries,
    journalKeyRange: {
      keyStartInclusive: params.journalKeyRange.keyStartInclusive,
      keyEndExclusive: params.journalKeyRange.keyEndExclusive,
      ...(params.journalKeyRange.valueKind === undefined
        ? {}
        : { valueKind: params.journalKeyRange.valueKind }),
    },
    journalKeyPrefix,
    journalValueJson,
    maxPluginEntries: resolveMaxPluginStateEntriesPerPlugin(),
    ...(params.cursorOptions.env ? { env: params.cursorOptions.env } : {}),
  });
}

/** Internal bounded read through the same shared-state worker as journal writes. */
export async function pluginStateEntriesInKeyRange(
  params: PluginStateKeyRangeParams & { env?: NodeJS.ProcessEnv },
): Promise<PluginStateEntry<unknown>[]> {
  validatePluginStateKeyRange(params);
  return listPluginStateInKeyRangeInWorker(params);
}

/** Doctor-only import that preserves source age and remaining retention. */
export function importPluginStateEntriesForDoctor(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  entries: readonly PluginStateImportEntry[],
): void {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
  });

  let batch: Array<PreparedRegisterParams & { createdAtMs: number }> = [];
  const flush = () => {
    pluginStateImportBatch({ pluginId, namespace, maxEntries, overflowPolicy, env }, batch);
    batch = [];
  };
  for (const entry of entries) {
    try {
      if (!Number.isSafeInteger(entry.createdAt)) {
        throw invalidInput("plugin state import createdAt must be a safe integer", "register");
      }
      const prepared = prepareRegisterParams(
        entry.key,
        entry.value,
        defaultTtlMs,
        entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
      );
      batch.push({ ...prepared, createdAtMs: entry.createdAt });
    } catch (error) {
      // Validation failure must not discard earlier valid rows in this batch.
      flush();
      throw error;
    }
    if (batch.length === PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS) {
      flush();
    }
  }
  flush();
}

/** Opens an async plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateKeyedStore<T>> {
  return createKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Opens a sync plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateSyncKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateSyncKeyedStore<T>> {
  return createSyncKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Clears plugin-state rows and option signatures for tests. */
function clearPluginStateStoreForTests(): void {
  clearPluginStateDatabaseForTests();
  optionPolicy.clear();
}

/** Resets plugin-state module/database state for isolated tests. */
export function resetPluginStateStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  if (options.closeDatabase !== false) {
    closePluginStateDatabase();
    closeOpenClawStateDatabaseForTest();
  }
  optionPolicy.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.pluginStateStoreTestApi")] = {
    clearPluginStateStoreForTests,
  };
}
