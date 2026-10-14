import type { Result } from "@openclaw/normalization-core/result";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { isRetainedPluginStateNamespace } from "./plugin-state-store.kernel.js";
import {
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
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateStoreError,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";
import {
  invalidInput,
  prepareKeyedStoreOptions,
  prepareLookupKeys,
  prepareRegisterParams,
  requireBoundedOptions,
  validateKey,
  type PreparedKeyedStoreOptions,
} from "./plugin-state-store.validation.js";

/** @deprecated Use openKeyedStoreV2; final compatibility day: 2026-12-31. */
export function createSyncKeyedStoreForPluginId<T>(
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

/** @deprecated Use openKeyedStoreV2; final compatibility day: 2026-12-31. */
export function createSyncKeyedStore<T>(
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
    /** @deprecated Await openKeyedStoreV2().register(). */
    register(key, value, opts) {
      warnLegacyUse("register");
      pluginStateRegister({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    /** @deprecated Await openKeyedStoreV2().registerIfAbsent(). */
    registerIfAbsent(key, value, opts) {
      warnLegacyUse("registerIfAbsent");
      return pluginStateRegisterIfAbsent({
        ...writeScope,
        ...prepareRegisterParams(key, value, defaultTtlMs, opts),
      });
    },
    /** @deprecated Use openKeyedStoreV2().observe() and compareAndApply(). */
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
          // SAFETY: This namespace stores the updater's caller-selected JSON type.
          const next = updateValue(current as T | undefined);
          assertActive?.();
          return next === undefined
            ? undefined
            : prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts, namespace);
        },
      });
    },
    /** @deprecated Use openKeyedStoreV2().observe() and compareAndApply(). */
    deleteIf(key, predicate) {
      warnLegacyUse("deleteIf", "openKeyedStoreV2().observe() and compareAndApply()");
      assertActive?.();
      return pluginStateDeleteIf({
        ...scope,
        key: validateKey(key, "delete"),
        predicate: (current) => {
          // SAFETY: The predicate receives this namespace's caller-selected JSON type.
          const result = predicate(current as T);
          assertActive?.();
          return result;
        },
      });
    },
    lookup(key) {
      warnLegacyUse("lookup");
      // SAFETY: The namespace's JSON value type is selected by the caller.
      return pluginStateLookup({ ...scope, key: validateKey(key, "lookup") }) as T | undefined;
    },
    /** @deprecated Await openKeyedStoreV2().lookupMany(). */
    lookupMany(keys) {
      warnLegacyUse("lookupMany");
      // SAFETY: This namespace uses the caller's JSON value type, as with lookup.
      return pluginStateLookupMany({ ...scope, keys: prepareLookupKeys(keys) }) as Array<
        Result<T | undefined, PluginStateStoreError>
      >;
    },
    /** @deprecated Await openKeyedStoreV2().consume(). */
    consume(key) {
      warnLegacyUse("consume");
      // SAFETY: The consumed row retains this namespace's caller-selected JSON type.
      return pluginStateConsume({ ...scope, key: validateKey(key, "consume") }) as T | undefined;
    },
    /** @deprecated Await openKeyedStoreV2().delete(). */
    delete(key) {
      warnLegacyUse("delete");
      return pluginStateDelete({ ...scope, key: validateKey(key, "delete") });
    },
    entries() {
      warnLegacyUse("entries");
      // SAFETY: Every entry comes from this namespace's caller-selected JSON type.
      return pluginStateEntries(scope) as PluginStateEntry<T>[];
    },
    count() {
      warnLegacyUse("count");
      return pluginStateCount(scope);
    },
    /** @deprecated Await openKeyedStoreV2().clear(). */
    clear() {
      warnLegacyUse("clear");
      pluginStateClear(scope);
    },
  };
}
