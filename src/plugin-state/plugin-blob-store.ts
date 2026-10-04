import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
} from "./plugin-blob-store.sqlite.js";
import type {
  OpenBlobStoreOptions,
  PluginBlobOverflowPolicy,
  PluginBlobStore,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";
import {
  clearPluginBlobsInWorker,
  lookupPluginBlobInWorker,
  listPluginBlobsInWorker,
  deletePluginBlobInWorker,
  deleteExpiredPluginBlobKeyInWorker,
  deleteExpiredPluginBlobsInWorker,
  registerPluginBlobInWorker,
  registerPluginBlobIfAbsentInWorker,
} from "./plugin-blob-worker-client.js";
import {
  createPluginStoreOptionPolicy,
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
  validatePluginStorePositiveInteger,
} from "./plugin-store-validation.js";

export type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "./plugin-blob-store.types.js";

type BlobStoreOptionSignature = {
  maxEntries: number;
  maxBytesPerEntry: number;
  maxBytesPerNamespace: number;
  overflowPolicy: PluginBlobOverflowPolicy;
  defaultTtlMs?: number;
};

function invalidInput(
  message: string,
  operation: PluginBlobStoreOperation = "register",
): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_INVALID_INPUT",
    operation,
  });
}

function limitError(message: string): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
    operation: "register",
  });
}

function validateNamespace(value: string): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin blob",
    invalid: (message) => invalidInput(message, "open"),
  });
}

function validateKey(value: string, operation: PluginBlobStoreOperation): string {
  return validatePluginStoreKey({
    value,
    label: "plugin blob",
    invalid: (message) => invalidInput(message, operation),
  });
}

function validatePositiveLimit(value: number, label: string, maximum: number): number {
  const normalized = validatePluginStorePositiveInteger({
    value,
    label,
    invalid: (message) => invalidInput(message, "open"),
  });
  if (normalized > maximum) {
    throw invalidInput(`${label} must be <= ${maximum}`, "open");
  }
  return normalized;
}

const optionPolicy = createPluginStoreOptionPolicy<BlobStoreOptionSignature>({
  label: "plugin blob",
  invalid: (message) => invalidInput(message, "open"),
});

function validateTtl(
  value: number | undefined,
  operation: PluginBlobStoreOperation,
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin blob ttlMs",
    invalid: (message) => invalidInput(message, operation),
  });
}

function createPluginBlobStoreInternal<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env?: NodeJS.ProcessEnv,
): PluginBlobStore<TMetadata> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validatePositiveLimit(
    options.maxEntries,
    "plugin blob maxEntries",
    MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
  );
  const maxBytesPerEntry = validatePositiveLimit(
    options.maxBytesPerEntry,
    "plugin blob maxBytesPerEntry",
    MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  );
  const maxBytesPerNamespace = validatePositiveLimit(
    options.maxBytesPerNamespace,
    "plugin blob maxBytesPerNamespace",
    MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  );
  if (maxBytesPerEntry > maxBytesPerNamespace) {
    throw invalidInput("plugin blob maxBytesPerEntry must not exceed maxBytesPerNamespace", "open");
  }
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateTtl(options.defaultTtlMs, "open");
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    maxBytesPerEntry,
    maxBytesPerNamespace,
    overflowPolicy,
    defaultTtlMs,
  });

  const scope = { pluginId, namespace, ...(env ? { env } : {}) };
  const prepareWrite = (
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ) => {
    const normalizedKey = validateKey(key, "register");
    if (!(bytes instanceof Uint8Array)) {
      throw invalidInput("plugin blob bytes must be a Uint8Array");
    }
    if (bytes.byteLength > maxBytesPerEntry) {
      throw limitError(`plugin blob entry exceeds the configured ${maxBytesPerEntry} byte limit`);
    }
    const metadataJson = serializePluginStoreJson({
      value: metadata,
      label: "plugin blob metadata",
      errors: { invalid: invalidInput, limit: limitError },
    });
    const ttlMs = validateTtl(opts?.ttlMs, "register") ?? defaultTtlMs;
    return {
      ...scope,
      key: normalizedKey,
      // Registration reserves broker capacity before copying, still before its first await.
      bytes,
      metadataJson,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      maxEntries,
      maxBytesPerNamespace,
      overflowPolicy,
    };
  };

  return {
    async register(key, bytes, metadata, opts) {
      await registerPluginBlobInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      return registerPluginBlobIfAbsentInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async lookup(key) {
      return lookupPluginBlobInWorker<TMetadata>({
        ...scope,
        key: validateKey(key, "lookup"),
      });
    },
    async entries() {
      return listPluginBlobsInWorker<TMetadata>(scope);
    },
    async delete(key) {
      return deletePluginBlobInWorker({
        ...scope,
        key: validateKey(key, "delete"),
      });
    },
    async deleteExpiredKey(key) {
      return deleteExpiredPluginBlobKeyInWorker<TMetadata>({
        ...scope,
        key: validateKey(key, "sweep"),
      });
    },
    async deleteExpired() {
      return deleteExpiredPluginBlobsInWorker<TMetadata>(scope);
    },
    async clear() {
      await clearPluginBlobsInWorker(scope);
    },
  };
}

/** Opens an async blob namespace for a non-core plugin id. */
export function createPluginBlobStore<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
): PluginBlobStore<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options);
}

/** Test-only factory with an isolated state environment. */
export function createPluginBlobStoreForTests<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env: NodeJS.ProcessEnv,
): PluginBlobStore<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options, env);
}

/** Resets facade signatures and the shared state database handle for tests. */
export function resetPluginBlobStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  optionPolicy.clear();
  if (options.closeDatabase !== false) {
    closeOpenClawStateDatabaseForTest();
  }
}
