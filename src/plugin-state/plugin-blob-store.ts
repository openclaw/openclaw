// Public facade for plugin-scoped SQLite blob storage.
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
  pluginBlobClear,
  pluginBlobDelete,
  pluginBlobDeleteExpiredKey,
  pluginBlobDeleteExpired,
  pluginBlobEntries,
  pluginBlobLookup,
  pluginBlobRegister,
  pluginBlobRegisterIfAbsent,
  type PluginBlobStoredEntry,
  type PluginBlobStoredInfo,
} from "./plugin-blob-store.sqlite.js";
import type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobOverflowPolicy,
  PluginBlobStore,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";
import {
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
  PluginBlobOverflowPolicy,
  PluginBlobStore,
} from "./plugin-blob-store.types.js";
export { PluginBlobStoreError } from "./plugin-blob-store.types.js";
export {
  MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
} from "./plugin-blob-store.sqlite.js";

type BlobStoreOptionSignature = {
  maxEntries: number;
  maxBytesPerEntry: number;
  maxBytesPerNamespace: number;
  overflowPolicy: PluginBlobOverflowPolicy;
  defaultTtlMs?: number;
};

type PreparedBlob = {
  key: string;
  bytes: Uint8Array;
  metadataJson: string;
  ttlMs?: number;
};

const namespaceOptionSignatures = new Map<string, BlobStoreOptionSignature>();

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

function validateOverflowPolicy(value: unknown): PluginBlobOverflowPolicy {
  if (value === undefined || value === "evict-oldest") {
    return "evict-oldest";
  }
  if (value === "reject-new") {
    return value;
  }
  throw invalidInput("plugin blob overflowPolicy must be evict-oldest or reject-new", "open");
}

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

function assertConsistentOptions(
  pluginId: string,
  namespace: string,
  signature: BlobStoreOptionSignature,
): void {
  const key = `${pluginId}\0${namespace}`;
  const existing = namespaceOptionSignatures.get(key);
  if (!existing) {
    namespaceOptionSignatures.set(key, signature);
    return;
  }
  if (
    existing.maxEntries !== signature.maxEntries ||
    existing.maxBytesPerEntry !== signature.maxBytesPerEntry ||
    existing.maxBytesPerNamespace !== signature.maxBytesPerNamespace ||
    existing.overflowPolicy !== signature.overflowPolicy ||
    existing.defaultTtlMs !== signature.defaultTtlMs
  ) {
    // Namespace limits are a shared contract. Reopening with different limits
    // would make quota and eviction behavior depend on call order.
    throw invalidInput(
      `plugin blob namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
      "open",
    );
  }
}

function prepareBlob<TMetadata>(params: {
  key: string;
  bytes: Uint8Array;
  metadata: TMetadata;
  maxBytesPerEntry: number;
  defaultTtlMs?: number;
  opts?: { ttlMs?: number };
}): PreparedBlob {
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
    bytes: Uint8Array.from(params.bytes),
    metadataJson,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

function parseMetadata<TMetadata>(
  raw: string,
  operation: PluginBlobStoreOperation,
  env?: NodeJS.ProcessEnv,
): TMetadata {
  try {
    return JSON.parse(raw) as TMetadata;
  } catch (error) {
    throw new PluginBlobStoreError("Plugin blob entry contains corrupt metadata JSON.", {
      code: "PLUGIN_BLOB_CORRUPT",
      operation,
      path: resolveOpenClawStateSqlitePath(env ?? process.env),
      cause: error,
    });
  }
}

function storedInfoToEntryInfo<TMetadata>(
  row: PluginBlobStoredInfo,
  operation: PluginBlobStoreOperation,
  env?: NodeJS.ProcessEnv,
): PluginBlobEntryInfo<TMetadata> {
  const expiresAt = normalizeSqliteNumber(row.expires_at);
  return {
    key: row.entry_key,
    metadata: parseMetadata<TMetadata>(row.metadata_json, operation, env),
    sizeBytes: Number(row.size_bytes),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function storedEntryToEntry<TMetadata>(
  row: PluginBlobStoredEntry,
  env?: NodeJS.ProcessEnv,
): PluginBlobEntry<TMetadata> {
  return {
    ...storedInfoToEntryInfo<TMetadata>(row, "lookup", env),
    bytes: Uint8Array.from(row.blob),
  };
}

/** Opens an async blob namespace for a non-core plugin id. */
export function createPluginBlobStore<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
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
  const overflowPolicy = validateOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateTtl(options.defaultTtlMs, "open");
  const env = options.env;
  assertConsistentOptions(pluginId, namespace, {
    maxEntries,
    maxBytesPerEntry,
    maxBytesPerNamespace,
    overflowPolicy,
    defaultTtlMs,
  });

  const writeParams = (blob: PreparedBlob) => ({
    pluginId,
    namespace,
    key: blob.key,
    bytes: blob.bytes,
    metadataJson: blob.metadataJson,
    maxEntries,
    maxBytesPerNamespace,
    overflowPolicy,
    ...(blob.ttlMs !== undefined ? { ttlMs: blob.ttlMs } : {}),
    ...(env ? { env } : {}),
  });

  return {
    async register(key, bytes, metadata, opts) {
      const blob = prepareBlob({
        key,
        bytes,
        metadata,
        maxBytesPerEntry,
        defaultTtlMs,
        opts,
      });
      pluginBlobRegister(writeParams(blob));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      const blob = prepareBlob({
        key,
        bytes,
        metadata,
        maxBytesPerEntry,
        defaultTtlMs,
        opts,
      });
      return pluginBlobRegisterIfAbsent(writeParams(blob));
    },
    async lookup(key) {
      const row = pluginBlobLookup({
        pluginId,
        namespace,
        key: validateKey(key, "lookup"),
        ...(env ? { env } : {}),
      });
      return row ? storedEntryToEntry<TMetadata>(row, env) : undefined;
    },
    async entries() {
      return pluginBlobEntries({ pluginId, namespace, ...(env ? { env } : {}) }).map((row) =>
        storedInfoToEntryInfo<TMetadata>(row, "entries", env),
      );
    },
    async delete(key) {
      return pluginBlobDelete({
        pluginId,
        namespace,
        key: validateKey(key, "delete"),
        ...(env ? { env } : {}),
      });
    },
    async deleteExpiredKey(key) {
      const row = pluginBlobDeleteExpiredKey({
        pluginId,
        namespace,
        key: validateKey(key, "sweep"),
        validateMetadataJson: (raw) => {
          parseMetadata<TMetadata>(raw, "sweep", env);
        },
        ...(env ? { env } : {}),
      });
      return row ? storedInfoToEntryInfo<TMetadata>(row, "sweep", env) : undefined;
    },
    async deleteExpired() {
      return pluginBlobDeleteExpired({
        pluginId,
        namespace,
        validateMetadataJson: (raw) => {
          parseMetadata<TMetadata>(raw, "sweep", env);
        },
        ...(env ? { env } : {}),
      }).map((row) => storedInfoToEntryInfo<TMetadata>(row, "sweep", env));
    },
    async clear() {
      pluginBlobClear({ pluginId, namespace, ...(env ? { env } : {}) });
    },
  };
}

/** Test-only named alias used by the public plugin-state test runtime. */
export const createPluginBlobStoreForTests = createPluginBlobStore;

/** Resets facade signatures and the shared state database handle for tests. */
export function resetPluginBlobStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  namespaceOptionSignatures.clear();
  if (options.closeDatabase !== false) {
    closeOpenClawStateDatabaseForTest();
  }
}
