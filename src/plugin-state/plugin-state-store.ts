// Plugin state store exposes persisted per-plugin state operations.
import { toUSVString } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { validatePluginStateComparison } from "./plugin-state-store.comparison.js";
import { preparePluginStateJournalValue } from "./plugin-state-store.journal.js";
import { isRetainedPluginStateNamespace } from "./plugin-state-store.kernel.js";
import {
  validatePluginStateKeyRange,
  type PluginStateKeyRangeParams,
} from "./plugin-state-store.reads.js";
import {
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
} from "./plugin-state-store.sqlite.js";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateStoreError,
  PluginStateSyncKeyedStore,
  PluginStateOverflowPolicy,
} from "./plugin-state-store.types.js";
import {
  invalidInput,
  optionPolicy,
  prepareKeyedStoreOptions,
  prepareLookupKeys,
  prepareRegisterParams,
  requireBoundedOptions,
  validateNamespace,
  validateKey,
  validateMaxEntries,
  validateOptionalTtlMs,
  type PluginStateImportEntry,
  type PreparedKeyedStoreOptions,
  type PreparedRegisterParams,
} from "./plugin-state-store.validation.js";
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
  movePluginStateEntriesInWorker,
  registerPluginStateJournalInWorker,
  lookupManyPluginStateInWorker,
  lookupPluginStateInWorker,
  registerPluginStateIfAbsentInWorker,
  registerPluginStateInWorker,
} from "./plugin-state-worker-client.js";
import { serializePluginStoreJson } from "./plugin-store-validation.js";

// Public plugin-state facade over the sqlite-backed store. It validates plugin
// ids, namespaces, JSON values, TTLs, and namespace limits before persistence.
export type {
  OpenAsyncKeyedStoreOptions,
  OpenRetainedKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyRange,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateMoveEntries,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";

export type { PluginDoctorRawStateEntry } from "./plugin-state-store.sqlite.js";

export {
  closePluginStateDatabaseAsync,
  getPluginStateCapacity,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
} from "./plugin-state-store.sqlite.js";

function createKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenAsyncKeyedStoreOptions,
  assertActive?: () => void,
): Required<PluginStateKeyedStore<T>> {
  const prepared = prepareKeyedStoreOptions(pluginId, options);
  const assertRetainedActive = options.retention === "retained" ? assertActive : undefined;
  const store = createSyncKeyedStore<T>(prepared, assertRetainedActive);
  return {
    ...createAsyncKeyedStore<T>(prepared, assertRetainedActive, assertActive),
    withCurrent: ({ assertCurrent }) => {
      if (typeof assertCurrent !== "function") {
        throw invalidInput("Plugin state action authority requires assertCurrent.");
      }
      const assertBoundCurrent = () => {
        assertActive?.();
        assertCurrent();
      };
      assertBoundCurrent();
      return createAsyncKeyedStore<T>(prepared, assertBoundCurrent);
    },
    update: async (...args) => store.update(...args),
    deleteIf: async (...args) => store.deleteIf(...args),
  };
}

function createAsyncKeyedStore<T>(
  prepared: PreparedKeyedStoreOptions,
  assertActive?: () => void,
  assertRangeActive = assertActive,
): PluginStateKeyedStore<T, 2> {
  const scope = {
    pluginId: prepared.pluginId,
    namespace: prepared.namespace,
    env: prepared.env,
    assertActive,
  };

  return {
    observe: async (key) => {
      const observation = await observePluginStateInWorker({
        ...scope,
        key: validateKey(key, "lookup"),
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
        ...scope,
        key: normalizedKey,
        comparison,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
      };
      let result: PluginStateCompareResult<unknown>;
      if (intent.operation === "update" && intent.action === "set") {
        const next = prepareRegisterParams(
          normalizedKey,
          intent.value,
          prepared.defaultTtlMs,
          { ttlMs: intent.ttlMs },
          prepared.namespace,
        );
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
      const entry = prepareRegisterParams(
        key,
        value,
        prepared.defaultTtlMs,
        opts,
        prepared.namespace,
      );
      await registerPluginStateInWorker({
        ...scope,
        ...entry,
        assertCurrent: opts?.assertCurrent,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
      });
    },
    registerIfAbsent: async (key, value, opts) => {
      const entry = prepareRegisterParams(
        key,
        value,
        prepared.defaultTtlMs,
        opts,
        prepared.namespace,
      );
      return await registerPluginStateIfAbsentInWorker({
        ...scope,
        maxEntries: prepared.maxEntries,
        overflowPolicy: prepared.overflowPolicy,
        ...entry,
      });
    },
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
        ...scope,
        key: normalizedKey,
        expected,
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
    delete: async (key, opts) => {
      const normalizedKey = validateKey(key, "delete");
      return await deletePluginStateInWorker({
        ...scope,
        key: normalizedKey,
        assertCurrent: opts?.assertCurrent,
      });
    },
    entries: async () => {
      // SAFETY: Entries come from this namespace and retain the caller's JSON value type.
      return (await listPluginStateInWorker(scope)) as PluginStateEntry<T>[];
    },
    entriesInKeyRange: async (range) => {
      const params = {
        ...scope,
        keyStartInclusive: range.keyStartInclusive,
        keyEndExclusive: range.keyEndExclusive,
        limit: range.limit,
        order: range.order,
        assertActive: assertRangeActive,
      };
      validatePluginStateKeyRange(params);
      // SAFETY: The range remains bound to this store's namespace and JSON value type.
      return (await listPluginStateInKeyRangeInWorker(params)) as PluginStateEntry<T>[];
    },
    moveEntriesFrom: async (source) => {
      assertActive?.();
      if (!isRetainedPluginStateNamespace(prepared.namespace)) {
        throw invalidInput("Plugin state moves require a retained destination.");
      }
      const sourceNamespace = validateNamespace(source.namespace, "register");
      if (source.entries.length > 10_000) {
        throw invalidInput("Plugin state moves accept at most 10000 entries.");
      }
      const targets = new Set<string>();
      const sources = new Set<string>();
      const entries = source.entries.map(({ sourceKey, targetKey }) => {
        const entry = {
          sourceKey: toUSVString(validateKey(sourceKey)),
          targetKey: toUSVString(validateKey(targetKey)),
        };
        if (targets.has(entry.targetKey) || sources.has(entry.sourceKey)) {
          throw invalidInput("Plugin state moves require unique source and target keys.");
        }
        targets.add(entry.targetKey);
        sources.add(entry.sourceKey);
        return entry;
      });
      return movePluginStateEntriesInWorker({
        ...scope,
        sourceNamespace,
        entries,
        assertActive,
      });
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
  requireBoundedOptions(options);
  return createSyncKeyedStore<T>(prepareKeyedStoreOptions(pluginId, options));
}

function createSyncKeyedStore<T>(
  { pluginId, namespace, maxEntries, overflowPolicy, defaultTtlMs, env }: PreparedKeyedStoreOptions,
  assertActive?: () => void,
): Required<PluginStateSyncKeyedStore<T>> {
  const scope = { pluginId, namespace, env };
  const writeScope = { ...scope, maxEntries, overflowPolicy };
  return {
    register(key, value, opts) {
      pluginStateRegister({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    registerIfAbsent(key, value, opts) {
      return pluginStateRegisterIfAbsent({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    update(key, updateValue, opts) {
      assertActive?.();
      if (isRetainedPluginStateNamespace(namespace) && opts?.ttlMs !== undefined) {
        throw invalidInput("Retained plugin state does not accept a TTL.");
      }
      const normalizedKey = validateKey(key, "register");
      return pluginStateUpdate({
        ...writeScope,
        key: normalizedKey,
        updateValueJson: (current) => {
          const next = updateValue(current as T | undefined);
          assertActive?.();
          return next === undefined
            ? undefined
            : prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts, namespace);
        },
      });
    },
    deleteIf(key, predicate) {
      assertActive?.();
      return pluginStateDeleteIf({
        ...scope,
        key: validateKey(key, "delete"),
        predicate: (current) => {
          const result = predicate(current as T);
          assertActive?.();
          return result;
        },
      });
    },
    lookup(key) {
      return pluginStateLookup({ ...scope, key: validateKey(key, "lookup") }) as T | undefined;
    },
    lookupMany(keys) {
      // SAFETY: This namespace uses the caller's JSON value type, as with lookup.
      return pluginStateLookupMany({ ...scope, keys: prepareLookupKeys(keys) }) as Array<
        Result<T | undefined, PluginStateStoreError>
      >;
    },
    consume(key) {
      return pluginStateConsume({ ...scope, key: validateKey(key, "consume") }) as T | undefined;
    },
    delete(key) {
      return pluginStateDelete({ ...scope, key: validateKey(key, "delete") });
    },
    entries() {
      return pluginStateEntries(scope) as PluginStateEntry<T>[];
    },
    count() {
      return pluginStateCount(scope);
    },
    clear() {
      pluginStateClear(scope);
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
  options: OpenAsyncKeyedStoreOptions,
  assertActive?: () => void,
): Required<PluginStateKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options, assertActive);
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
  requireBoundedOptions(params.cursorOptions);
  requireBoundedOptions(params.journalOptions);
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
  requireBoundedOptions(options);
  const preparedOptions = prepareKeyedStoreOptions(pluginId, options);

  let batch: Array<PreparedRegisterParams & { createdAtMs: number }> = [];
  const flush = () => {
    pluginStateImportBatch(preparedOptions, batch);
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
        preparedOptions.defaultTtlMs,
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
  options: OpenAsyncKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateKeyedStore<T>> {
  return createKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Opens a sync plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateSyncKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateSyncKeyedStore<T>> {
  return createSyncKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Resets plugin-state module/database state for isolated tests. */
export function resetPluginStateStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  if (options.closeDatabase !== false) {
    closePluginStateDatabase();
    closeOpenClawStateDatabaseForTest();
  }
  optionPolicy.clear();
}
