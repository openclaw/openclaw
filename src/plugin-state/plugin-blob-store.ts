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

const validationErrors = (operation: PluginBlobStoreOperation) => ({
  invalid: (message: string) => invalidInput(message, operation),
  limit: (message: string) => limitError(message),
});

function validateNamespace(value: string): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin blob",
    errors: validationErrors("open"),
  });
}

function validateKey(value: string, operation: PluginBlobStoreOperation): string {
  return validatePluginStoreKey({
    value,
    label: "plugin blob",
    errors: validationErrors(operation),
  });
}

function validatePositiveLimit(value: number, label: string, maximum: number): number {
  const normalized = validatePluginStorePositiveInteger({
    value,
    label,
    errors: validationErrors("open"),
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
    errors: validationErrors(operation),
  });
}

function prepareBlob(params: {
  key: string;
  bytes: Uint8Array;
  metadata: unknown;
  maxBytesPerEntry: number;
  defaultTtlMs?: number;
  opts?: { ttlMs?: number };
}) {
  const key = validateKey(params.key, "register");
  if (!(params.bytes instanceof Uint8Array)) {
    throw invalidInput("plugin blob bytes must be a Uint8Array");
  }
  if (params.bytes.byteLength > params.maxBytesPerEntry) {
    throw limitError(
      `plugin blob entry exceeds the configured ${params.maxBytesPerEntry} byte limit`,
    );
  }
  const metadataJson = serializePluginStoreJson({
    value: params.metadata,
    label: "plugin blob metadata",
    errors: validationErrors("register"),
  });
  const ttlMs = validateTtl(params.opts?.ttlMs, "register") ?? params.defaultTtlMs;
  return {
    key,
    // Registration reserves broker capacity before copying, still before its first await.
    bytes: params.bytes,
    metadataJson,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
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

  const prepareWrite = (
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ) => ({
    pluginId,
    namespace,
    ...prepareBlob({ key, bytes, metadata, maxBytesPerEntry, defaultTtlMs, opts }),
    maxEntries,
    maxBytesPerNamespace,
    overflowPolicy,
    ...(env ? { env } : {}),
  });

  return {
    async register(key, bytes, metadata, opts) {
      await registerPluginBlobInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      return registerPluginBlobIfAbsentInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async lookup(key) {
      return lookupPluginBlobInWorker<TMetadata>({
        pluginId,
        namespace,
        key: validateKey(key, "lookup"),
        ...(env ? { env } : {}),
      });
    },
    async entries() {
      return listPluginBlobsInWorker<TMetadata>({ pluginId, namespace, ...(env ? { env } : {}) });
    },
    async delete(key) {
      return deletePluginBlobInWorker({
        pluginId,
        namespace,
        key: validateKey(key, "delete"),
        ...(env ? { env } : {}),
      });
    },
    async deleteExpiredKey(key) {
      return deleteExpiredPluginBlobKeyInWorker<TMetadata>({
        pluginId,
        namespace,
        key: validateKey(key, "sweep"),
        ...(env ? { env } : {}),
      });
    },
    async deleteExpired() {
      return deleteExpiredPluginBlobsInWorker<TMetadata>({
        pluginId,
        namespace,
        ...(env ? { env } : {}),
      });
    },
    async clear() {
      await clearPluginBlobsInWorker({ pluginId, namespace, ...(env ? { env } : {}) });
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
