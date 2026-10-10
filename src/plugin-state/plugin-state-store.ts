import { toUSVString } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import type {
  SessionEntryCurrentCheck,
  SessionEntriesCurrentCheck,
} from "../config/sessions/session-entry-current.types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createPluginStateOperation } from "./plugin-state-operation.js";
import { validatePluginStateComparison } from "./plugin-state-store.comparison.js";
import {
  preparePluginStateJournalValue,
  type PluginStateSequencedJournalParams,
} from "./plugin-state-store.journal.js";
import { isRetainedPluginStateNamespace } from "./plugin-state-store.kernel.js";
import {
  bindPluginStateNativeBindingStore,
  type PluginStateOperationModuleSource,
} from "./plugin-state-store.native-binding.js";
import {
  validatePluginStateKeyRange,
  type PluginStateKeyRangeParams,
} from "./plugin-state-store.reads.js";
import {
  closePluginStateDatabase,
  MAX_PLUGIN_STATE_VALUE_BYTES,
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
  PluginStateActionAuthority,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateStoreError,
  PluginStateSyncKeyedStore,
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
  replacePluginStateInWorker,
  replacePluginStateEntryInWorker,
} from "./plugin-state-worker-client.js";
import { serializePluginStoreJson } from "./plugin-store-validation.js";

export type {
  OpenAsyncKeyedStoreOptions,
  OpenRetainedKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateComparisonCondition,
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyRange,
  PluginStateKeyedStore,
  PluginStateObservation,
  PluginStateMoveEntries,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";

export {
  importPluginStateEntriesForDoctor,
  registerMigratedPluginStateEntry,
} from "./plugin-state-store.migration.js";

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
  moduleSource?: PluginStateOperationModuleSource,
  warningPluginId?: string,
): Required<PluginStateKeyedStore<T>> {
  const prepared = prepareKeyedStoreOptions(pluginId, options);
  const assertRetainedActive = options.retention === "retained" ? assertActive : undefined;
  const store = createSyncKeyedStore<T>(
    prepared,
    assertRetainedActive,
    "PluginStateKeyedStore",
    warningPluginId,
  );
  const asyncStore: Required<PluginStateKeyedStore<T>> = {
    ...createAsyncKeyedStore<T>(
      prepared,
      assertRetainedActive,
      assertActive,
      undefined,
      moduleSource,
    ),
    withCurrent: ({ assertCurrent, sessionEntryCurrent }) => {
      if (typeof assertCurrent !== "function") {
        throw invalidInput("Plugin state action authority requires assertCurrent.");
      }
      const assertBoundCurrent = () => {
        assertActive?.();
        assertCurrent();
      };
      assertBoundCurrent();
      return createAsyncKeyedStore<T>(
        prepared,
        assertBoundCurrent,
        assertBoundCurrent,
        sessionEntryCurrent,
        moduleSource,
      );
    },
    update: async (...args) => store.update(...args),
    deleteIf: async (...args) => store.deleteIf(...args),
  };
  return bindPluginStateNativeBindingStore(
    asyncStore,
    prepared,
    assertActive,
    undefined,
    moduleSource,
  );
}

function createAsyncKeyedStore<T>(
  prepared: PreparedKeyedStoreOptions,
  assertActive?: () => void,
  assertRangeActive = assertActive,
  sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck,
  moduleSource?: PluginStateOperationModuleSource,
): Required<PluginStateKeyedStore<T, 2>> {
  const scope = {
    pluginId: prepared.pluginId,
    namespace: prepared.namespace,
    env: prepared.env,
    assertActive,
    sessionEntryCurrent,
  };

  const store: Required<PluginStateKeyedStore<T, 2>> = {
    createOperation: (stores, handler, authority) =>
      createPluginStateOperation(store, stores, handler, authority),
    observe: async (key) => {
      const observation = await observePluginStateInWorker({
        ...scope,
        key: validateKey(key, "lookup"),
      });
      // SAFETY: The namespace's JSON value type is caller-owned, as with lookup.
      return observation as PluginStateObservation<T>;
    },
    compareAndApply: async (key, comparison, intent, options) => {
      if (intent?.operation !== "update" && intent?.operation !== "delete") {
        throw invalidInput("Plugin state comparison requires an update or delete intent.");
      }
      const operation = intent.operation === "update" ? "register" : "delete";
      const normalizedKey = validateKey(key, operation);
      validatePluginStateComparison(comparison, operation);
      if (options && options.conditions.length > 100) {
        throw invalidInput("Plugin state comparisons accept at most 100 conditions.", operation);
      }
      const conditions = options?.conditions.map((condition) => {
        validatePluginStateComparison(condition.comparison, operation);
        return {
          namespace: validateNamespace(condition.namespace, operation),
          key: validateKey(condition.key, operation),
          comparison: condition.comparison,
        };
      });
      const common = {
        ...scope,
        key: normalizedKey,
        comparison,
        conditions,
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
        signal: opts?.signal,
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
  return bindPluginStateNativeBindingStore(
    store,
    prepared,
    assertRangeActive,
    sessionEntryCurrent,
    moduleSource,
  );
}

function createSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  warn = true,
  warningPluginId?: string,
): Required<PluginStateSyncKeyedStore<T>> {
  requireBoundedOptions(options);
  return createSyncKeyedStore<T>(
    prepareKeyedStoreOptions(pluginId, options),
    undefined,
    warn ? "PluginStateSyncKeyedStore" : undefined,
    warningPluginId,
  );
}

function createSyncKeyedStore<T>(
  { pluginId, namespace, maxEntries, overflowPolicy, defaultTtlMs, env }: PreparedKeyedStoreOptions,
  assertActive?: () => void,
  legacyContract?: "PluginStateKeyedStore" | "PluginStateSyncKeyedStore",
  warningPluginId?: string,
): Required<PluginStateSyncKeyedStore<T>> {
  const scope = { pluginId, namespace, env };
  const writeScope = { ...scope, maxEntries, overflowPolicy };
  const warnLegacyUse = (method: string, replacement = `openKeyedStoreV2().${method}()`) => {
    if (legacyContract) {
      warnPluginSdkDeprecation({
        pluginId: warningPluginId,
        family: "plugin-state-keyed-store",
        method: `${legacyContract}.${method}`,
        replacement: `await ${replacement}`,
        compatibility:
          "Synchronous operations still commit before returning; legacy callbacks retain transaction-local ordering.",
      });
    }
  };
  return {
    register(key, value, opts) {
      warnLegacyUse("register");
      pluginStateRegister({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    registerIfAbsent(key, value, opts) {
      warnLegacyUse("registerIfAbsent");
      return pluginStateRegisterIfAbsent({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    update(key, updateValue, opts) {
      warnLegacyUse("update", "openKeyedStoreV2().observe() and compareAndApply()");
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
      warnLegacyUse("deleteIf", "openKeyedStoreV2().observe() and compareAndApply()");
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
      warnLegacyUse("lookup");
      return pluginStateLookup({ ...scope, key: validateKey(key, "lookup") }) as T | undefined;
    },
    lookupMany(keys) {
      warnLegacyUse("lookupMany");
      // SAFETY: This namespace uses the caller's JSON value type, as with lookup.
      return pluginStateLookupMany({ ...scope, keys: prepareLookupKeys(keys) }) as Array<
        Result<T | undefined, PluginStateStoreError>
      >;
    },
    consume(key) {
      warnLegacyUse("consume");
      return pluginStateConsume({ ...scope, key: validateKey(key, "consume") }) as T | undefined;
    },
    delete(key) {
      warnLegacyUse("delete");
      return pluginStateDelete({ ...scope, key: validateKey(key, "delete") });
    },
    entries() {
      warnLegacyUse("entries");
      return pluginStateEntries(scope) as PluginStateEntry<T>[];
    },
    count() {
      warnLegacyUse("count");
      return pluginStateCount(scope);
    },
    clear() {
      warnLegacyUse("clear");
      pluginStateClear(scope);
    },
  };
}

/** Opens an async plugin-state namespace for a non-core plugin id. */
export function createPluginStateKeyedStore<T>(
  pluginId: string,
  options: OpenAsyncKeyedStoreOptions,
  assertActive?: () => void,
  moduleSource?: PluginStateOperationModuleSource,
): Required<PluginStateKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options, assertActive, moduleSource, pluginId);
}

/** Opens a data-only worker store bound to the retained caller's lifetime and authority. */
export function createPluginStateKeyedStoreV2<T>(
  pluginId: string,
  options: OpenAsyncKeyedStoreOptions,
  authority: PluginStateActionAuthority,
  moduleSource?: PluginStateOperationModuleSource,
): PluginStateKeyedStore<T, 2> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  if (typeof authority.assertCurrent !== "function") {
    throw invalidInput("Plugin state action authority requires assertCurrent.");
  }
  authority.assertCurrent();
  return createAsyncKeyedStore<T>(
    prepareKeyedStoreOptions(pluginId, options),
    authority.assertCurrent,
    authority.assertCurrent,
    authority.sessionEntryCurrent,
    moduleSource,
  );
}

/** Registry-owned stores retain diagnostic identity after the opening invocation ends. */
export function createPluginStateRuntimeStores(
  pluginId: string,
  assertRuntimeCurrent: () => void,
  captureModuleSource?: () => PluginStateOperationModuleSource | undefined,
) {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return {
    openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
      if (options.retention === "retained") {
        assertRuntimeCurrent();
      }
      return createKeyedStoreForPluginId<T>(
        pluginId,
        options,
        assertRuntimeCurrent,
        captureModuleSource?.(),
        pluginId,
      );
    },
    openKeyedStoreV2: <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority?: PluginStateActionAuthority,
    ) =>
      createPluginStateKeyedStoreV2<T>(
        pluginId,
        options,
        {
          assertCurrent: () => {
            assertRuntimeCurrent();
            authority?.assertCurrent();
          },
          sessionEntryCurrent: authority?.sessionEntryCurrent,
        },
        captureModuleSource?.(),
      ),
    openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createSyncKeyedStoreForPluginId<T>(pluginId, options, true, pluginId),
  };
}

/**
 * Named adapter for the plugin-state-sync-keyed-store compatibility contract.
 * @deprecated Use createPluginStateKeyedStoreV2 or api.runtime.state.openKeyedStoreV2
 * and await its operations. This adapter will be removed in the next Plugin SDK major.
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
  journalKeyRange: PluginStateSequencedJournalParams["journalKeyRange"];
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

/** Opens an async plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateKeyedStore<T>(
  options: OpenAsyncKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateKeyedStore<T>> {
  return createKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Bind a core catalog read and its later replacement to the same physical store. */
export function prepareCorePluginStateReplacement<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
) {
  const prepared = prepareKeyedStoreOptions(options.ownerId, options);
  const context = captureOpenClawStateWorkerContext({ env: prepared.env });
  const scope = { ...prepared, context };
  return {
    async entries(): Promise<PluginStateEntry<T>[]> {
      // SAFETY: This namespace stores the core caller's serialized JSON value type.
      return (await listPluginStateInWorker(scope)) as PluginStateEntry<T>[];
    },
    async replace(entries: ReadonlyMap<string, T>): Promise<void> {
      const values = Array.from(entries, ([key, value]) =>
        prepareRegisterParams(key, value, prepared.defaultTtlMs, undefined, prepared.namespace),
      );
      await replacePluginStateInWorker({ ...scope, entries: values });
    },
  };
}

/** Revoke the prior entry before installing its replacement, including failed preparation. */
export async function replaceCorePluginStateEntry(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
  key: string,
  value: unknown,
  opts?: { ttlMs?: number; assertCurrent?: () => void },
): Promise<void> {
  const prepared = prepareKeyedStoreOptions(options.ownerId, options);
  const context = captureOpenClawStateWorkerContext({ env: prepared.env });
  const normalizedKey = validateKey(key);
  const scope = { ...prepared, context, assertCurrent: opts?.assertCurrent };
  let entry: PreparedRegisterParams;
  try {
    entry = prepareRegisterParams(
      normalizedKey,
      value,
      prepared.defaultTtlMs,
      opts,
      prepared.namespace,
    );
  } catch (error) {
    await deletePluginStateInWorker({ ...scope, key: normalizedKey });
    throw error;
  }
  await replacePluginStateEntryInWorker({ ...scope, ...entry });
}

/** Opens a sync plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateSyncKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateSyncKeyedStore<T>> {
  return createSyncKeyedStoreForPluginId<T>(options.ownerId, options, false);
}

/** Resets plugin-state module/database state for isolated tests. */
export function resetPluginStateStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  if (options.closeDatabase !== false) {
    closePluginStateDatabase();
    closeOpenClawStateDatabaseForTest();
  }
  optionPolicy.clear();
}
