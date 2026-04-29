import {
  closePluginStateSqliteStore,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  pluginStateClear,
  pluginStateConsume,
  pluginStateDelete,
  pluginStateEntries,
  pluginStateLookup,
  pluginStateRegister,
} from "./plugin-state-store.sqlite.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
} from "./plugin-state-store.types.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

export type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateStoreErrorCode,
  PluginStateStoreOperation,
  PluginStateStoreProbeResult,
  PluginStateStoreProbeStep,
} from "./plugin-state-store.types.js";
export { PluginStateStoreError } from "./plugin-state-store.types.js";
export {
  closePluginStateSqliteStore,
  isPluginStateDatabaseOpen,
  probePluginStateStore,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.sqlite.js";

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

type StoreOptionSignature = {
  maxEntries: number;
  defaultTtlMs?: number;
};

const namespaceOptionSignatures = new Map<string, StoreOptionSignature>();
const textEncoder = new TextEncoder();

function invalidInput(message: string): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation: "register",
  });
}

function validateNamespace(value: string): string {
  const trimmed = value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw invalidInput(`plugin state namespace must be a safe path segment: ${value}`);
  }
  return trimmed;
}

function validateKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw invalidInput("plugin state entry key must not be empty");
  }
  return trimmed;
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput("plugin state maxEntries must be an integer >= 1");
  }
  return value;
}

function validateOptionalTtlMs(value: number | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw invalidInput("plugin state ttlMs must be an integer >= 0");
  }
  return value;
}

function assertPlainJsonValue(value: unknown, seen: WeakSet<object>, path: string): void {
  if (value === null) {
    return;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return;
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput(`plugin state value at ${path} must be a finite number`);
    }
    return;
  }
  if (valueType !== "object") {
    throw invalidInput(`plugin state value at ${path} must be JSON-serializable`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw invalidInput(`plugin state value at ${path} must not contain circular references`);
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw invalidInput(`plugin state array at ${path} must not be sparse`);
        }
        assertPlainJsonValue(value[index], seen, `${path}[${index}]`);
      }
      return;
    }

    if (Object.getPrototypeOf(objectValue) !== Object.prototype) {
      throw invalidInput(`plugin state object at ${path} must be a plain object`);
    }

    const descriptorEntries = Object.entries(Object.getOwnPropertyDescriptors(objectValue));
    const enumerableKeys = Object.keys(objectValue);
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw invalidInput(`plugin state object at ${path} must not use symbol keys`);
    }
    if (descriptorEntries.length !== enumerableKeys.length) {
      throw invalidInput(`plugin state object at ${path} must not use non-enumerable properties`);
    }
    for (const [key, descriptor] of descriptorEntries) {
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw invalidInput(`plugin state object at ${path}.${key} must use data properties`);
      }
      assertPlainJsonValue(descriptor.value, seen, `${path}.${key}`);
    }
  } finally {
    seen.delete(objectValue);
  }
}

function assertJsonSerializable(value: unknown): void {
  assertPlainJsonValue(value, new WeakSet<object>(), "value");
}

function assertValueSize(json: string): void {
  if (textEncoder.encode(json).byteLength > MAX_PLUGIN_STATE_VALUE_BYTES) {
    throw new PluginStateStoreError("plugin state value exceeds 64KB limit", {
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
    });
  }
}

function assertConsistentOptions(
  pluginId: string,
  namespace: string,
  signature: StoreOptionSignature,
): void {
  const key = `${pluginId}\0${namespace}`;
  const existing = namespaceOptionSignatures.get(key);
  if (!existing) {
    namespaceOptionSignatures.set(key, signature);
    return;
  }
  if (
    existing.maxEntries !== signature.maxEntries ||
    existing.defaultTtlMs !== signature.defaultTtlMs
  ) {
    throw invalidInput(
      `plugin state namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
    );
  }
}

function createKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  assertConsistentOptions(pluginId, namespace, { maxEntries, defaultTtlMs });

  return {
    async register(key, value, opts) {
      const normalizedKey = validateKey(key);
      assertJsonSerializable(value);
      const json = JSON.stringify(value);
      assertValueSize(json);
      const ttlMs = validateOptionalTtlMs(opts?.ttlMs) ?? defaultTtlMs;
      pluginStateRegister({
        pluginId,
        namespace,
        key: normalizedKey,
        valueJson: json,
        maxEntries,
        ...(ttlMs != null ? { ttlMs } : {}),
      });
    },
    async lookup(key) {
      const normalizedKey = validateKey(key);
      return pluginStateLookup({ pluginId, namespace, key: normalizedKey }) as T | undefined;
    },
    async consume(key) {
      const normalizedKey = validateKey(key);
      return pluginStateConsume({ pluginId, namespace, key: normalizedKey }) as T | undefined;
    },
    async delete(key) {
      const normalizedKey = validateKey(key);
      return pluginStateDelete({ pluginId, namespace, key: normalizedKey });
    },
    async entries() {
      return pluginStateEntries({ pluginId, namespace }) as PluginStateEntry<T>[];
    },
    async clear() {
      pluginStateClear({ pluginId, namespace });
    },
  };
}

export function createPluginStateKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options);
}

export function createCorePluginStateKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): PluginStateKeyedStore<T> {
  return createKeyedStoreForPluginId<T>(options.ownerId, options);
}

export function resetPluginStateStoreForTests(): void {
  closePluginStateSqliteStore();
  namespaceOptionSignatures.clear();
}
