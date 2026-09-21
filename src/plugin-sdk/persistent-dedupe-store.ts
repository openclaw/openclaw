// Owns persistent replay key codecs and per-operation database admission capture.
import { createHash } from "node:crypto";
import { resolveNonNegativeIntegerOption } from "../../packages/normalization-core/src/number-coercion.js";
import { wrapPluginStateError } from "../plugin-state/plugin-state-store.database.js";
import {
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type {
  ClaimableDedupeOptions,
  PersistentDedupeOptions,
  PersistentDedupePluginStateOptions,
  PersistentDedupeEntry,
  PersistentDedupeLegacyJsonImportEntry,
} from "./persistent-dedupe.types.js";

const LEGACY_PATH_OWNER_ID = "core:persistent-dedupe";
const DEFAULT_NAMESPACE_PREFIX = "persistent-dedupe";

export function resolveNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

export function resolveScopedKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function resolveEntryKey(key: string): string {
  return `k.${shortHash(key)}`;
}

export function createPersistentDedupeImportEntry(params: {
  key: string;
  seenAt: number;
  ttlMs?: number;
}): PersistentDedupeLegacyJsonImportEntry {
  return {
    key: resolveEntryKey(params.key),
    value: { key: params.key, seenAt: params.seenAt },
    ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
  };
}

function normalizeNamespacePrefix(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_NAMESPACE_PREFIX)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return normalized || DEFAULT_NAMESPACE_PREFIX;
}

function resolveStateNamespace(prefix: string, namespace: string): string {
  return `${prefix}.${shortHash(namespace)}`;
}

export function resolvePersistentDedupePluginStateNamespace(options: {
  namespace: string;
  namespacePrefix?: string;
}): string {
  return resolveStateNamespace(
    normalizeNamespacePrefix(options.namespacePrefix),
    resolveNamespace(options.namespace),
  );
}

export function hasPluginStateOptions(
  options: ClaimableDedupeOptions | PersistentDedupeOptions,
): options is PersistentDedupePluginStateOptions {
  return typeof options.pluginId === "string";
}

function resolveStateMaxEntries(options: PersistentDedupeOptions): number {
  const maxEntries = hasPluginStateOptions(options)
    ? options.stateMaxEntries
    : options.fileMaxEntries;
  return Math.max(1, resolveNonNegativeIntegerOption(maxEntries, 1));
}

export type CapturedPersistentStore = {
  namespace: string;
  get: () => Required<PluginStateKeyedStore<PersistentDedupeEntry>>;
};

export function createPersistentStoreResolver(options: PersistentDedupeOptions) {
  const maxEntries = resolveStateMaxEntries(options);
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const defaultTtlMs = ttlMs > 0 ? ttlMs : undefined;
  const pluginId = hasPluginStateOptions(options) ? options.pluginId : undefined;
  const prefix = normalizeNamespacePrefix(
    hasPluginStateOptions(options) ? options.namespacePrefix : "legacy-path",
  );
  return (namespace: string): CapturedPersistentStore => {
    let databasePath: string | undefined;
    try {
      databasePath = resolveOpenClawStateSqlitePath(options.env ?? process.env);
      const context = captureOpenClawStateWorkerContext({ path: databasePath, env: options.env });
      const storeOptions = {
        namespace: hasPluginStateOptions(options)
          ? resolveStateNamespace(prefix, namespace)
          : resolveStateNamespace(prefix, options.resolveFilePath(namespace)),
        maxEntries,
        ...(defaultTtlMs != null ? { defaultTtlMs } : {}),
        env: context.environment,
      };
      let store: ReturnType<CapturedPersistentStore["get"]> | undefined;
      return {
        namespace: storeOptions.namespace,
        get: () => {
          // Each worker call captures matching admission synchronously after this check.
          context.admission.assertCurrent();
          return (store ??=
            pluginId !== undefined
              ? createPluginStateKeyedStore<PersistentDedupeEntry>(pluginId, storeOptions)
              : createCorePluginStateKeyedStore<PersistentDedupeEntry>({
                  ...storeOptions,
                  ownerId: LEGACY_PATH_OWNER_ID,
                }));
        },
      };
    } catch (error) {
      // Memory-only hits do not require a usable database, as before the worker cutover.
      const failure = wrapPluginStateError(
        error,
        "lookup",
        "PLUGIN_STATE_OPEN_FAILED",
        "Failed to open the plugin state database.",
        databasePath,
      );
      return {
        namespace,
        get: () => {
          throw failure;
        },
      };
    }
  };
}
