import {
  PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS,
  pluginStateImportBatch,
  pluginStateRegister,
} from "./plugin-state-store.sqlite.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateOverflowPolicy,
} from "./plugin-state-store.types.js";
import {
  invalidInput,
  optionPolicy,
  prepareKeyedStoreOptions,
  prepareRegisterParams,
  requireBoundedOptions,
  validateNamespace,
  validateMaxEntries,
  validateOptionalTtlMs,
  type PluginStateImportEntry,
  type PreparedRegisterParams,
} from "./plugin-state-store.validation.js";

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
