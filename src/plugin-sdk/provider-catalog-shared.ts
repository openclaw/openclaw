import { createHash } from "node:crypto";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  consumeLiveCatalogRefresh,
  recordLiveCatalogExpiry,
} from "../plugins/provider-catalog-expiry.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export { normalizeOpenRouterModelReasoning } from "@openclaw/model-catalog-core/model-catalog-normalize";

export type {
  ProviderCatalogContext,
  ProviderConfiguredModelRef,
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/types.js";

export { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";

export {
  buildManifestModelProviderConfig,
  buildManifestProviderCatalogFamily,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
  readManifestProviderDefaultModelRef,
  resolveFirstProviderCatalogAuth,
  type ManifestProviderCatalogEntry,
} from "../plugins/provider-catalog.js";

/**
 * Normalized model row read from user config for provider catalog augmentation.
 */
export type ConfiguredProviderCatalogEntry = {
  /** Normalized model id as exposed through provider catalog discovery. */
  id: string;
  /** Display name from config, falling back to the normalized id. */
  name: string;
  /** Published provider id attached to this catalog entry. */
  provider: string;
  /** Optional context window copied from the configured model row when positive. */
  contextWindow?: number;
  /** Whether the configured model advertises reasoning support. */
  reasoning?: boolean;
  /** Runtime input modalities retained from the configured model row. */
  input?: Array<"text" | "image" | "audio" | "video" | "document">;
};

type LiveCatalogCacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
  settled: boolean;
  retained: boolean;
};

const LIVE_CATALOG_CACHE_MAX_ENTRIES = 100;
const liveCatalogCache = new Map<string, unknown>();

async function consumeLiveCatalog<T>(entry: LiveCatalogCacheEntry<T>, signal?: AbortSignal) {
  const value = await racePromiseWithAbortSignal(entry.value, signal, (aborted) => aborted.reason);
  if (entry.retained) {
    recordLiveCatalogExpiry(entry.expiresAt);
  }
  return value;
}

function buildLiveCatalogCacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Shares pending loads and caches successful values for a short TTL after completion.
 */
export async function getCachedLiveCatalogValue<T>(params: {
  /** Stable JSON-serializable values that identify one provider/config catalog load. */
  keyParts: readonly unknown[];
  /** Loader for the live catalog value when no fresh cache entry exists. */
  load: (signal?: AbortSignal) => Promise<T>;
  /** Cancels this consumer; admitted metadata loads finish within their own deadline. */
  signal?: AbortSignal;
  /** Optional predicate for values that are healthy enough to retain. */
  shouldCache?: (value: T) => boolean;
  /** Successful-value cache lifetime in milliseconds; defaults to a short discovery TTL. */
  ttlMs?: number;
  /** Test hook for deterministic cache expiry. */
  now?: () => number;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const rawNow = params.now?.() ?? Date.now();
  const ttlMs = params.ttlMs ?? 30_000;
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  // Uncached callers must neither reuse nor disturb an existing entry.
  if (expiresAt === undefined) {
    return await params.load(params.signal);
  }
  const key = buildLiveCatalogCacheKey(params.keyParts);
  const refresh = consumeLiveCatalogRefresh(key);
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing) {
    if (
      (!refresh || !existing.settled) &&
      isFutureDateTimestampMs(existing.expiresAt, { nowMs: rawNow })
    ) {
      return await consumeLiveCatalog(existing, params.signal);
    }
    liveCatalogCache.delete(key);
  }
  const entry: LiveCatalogCacheEntry<T> = {
    expiresAt,
    settled: false,
    retained: false,
    // Read-only metadata may finish and warm the cache after every observer cancels.
    value: params.load(),
  };
  entry.value = entry.value
    .then((resolved) => {
      if (params.shouldCache?.(resolved) ?? true) {
        // A slow success gets a complete TTL without reviving an evicted entry.
        const completedExpiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, {
          nowMs: params.now?.() ?? Date.now(),
        });
        if (completedExpiresAt !== undefined) {
          entry.expiresAt = completedExpiresAt;
          entry.retained = true;
        }
      }
      return resolved;
    })
    .finally(() => {
      entry.settled = true;
      if (!entry.retained && liveCatalogCache.get(key) === entry) {
        liveCatalogCache.delete(key);
      }
    });
  // Auth-scoped catalogs vary by token. Bound retained entries without rejecting
  // new catalogs or canceling consumers of an evicted load.
  pruneMapToMaxSize(liveCatalogCache, LIVE_CATALOG_CACHE_MAX_ENTRIES - 1);
  liveCatalogCache.set(key, entry);
  return await consumeLiveCatalog(entry, params.signal);
}

/**
 * Clears the process-local live catalog cache for tests and isolated plugin probes.
 */
export function clearLiveCatalogCacheForTests(): void {
  liveCatalogCache.clear();
}

function resolveConfiguredProviderModels(
  config: OpenClawConfig | undefined,
  providerId: string,
): ModelDefinitionConfig[] {
  const providers = config?.models?.providers;
  if (!providers) {
    return [];
  }
  const providerKey = findNormalizedProviderKey(providers, providerId);
  if (!providerKey) {
    return [];
  }
  return providers[providerKey]?.models ?? [];
}

/**
 * Reads user-configured provider models as catalog entries for plugin discovery output.
 */
export function readConfiguredProviderCatalogEntries(params: {
  /** Runtime config containing optional user-defined provider model rows. */
  config?: OpenClawConfig;
  /** Provider id used to locate configured model rows. */
  providerId: string;
  /** Provider id to publish on emitted catalog entries when it differs from lookup id. */
  publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[] {
  const provider = params.publishedProviderId ?? params.providerId;
  const models = resolveConfiguredProviderModels(params.config, params.providerId);
  const entries: ConfiguredProviderCatalogEntry[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id) {
      continue;
    }
    const normalizedId = normalizeConfiguredProviderCatalogModelId(provider, id);
    const name = model.name.trim() || normalizedId;
    entries.push({
      provider,
      id: normalizedId,
      name,
      ...((model.contextWindow ?? 0) > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.input?.length ? { input: model.input } : {}),
    });
  }
  return entries;
}

function withStreamingUsageCompat(provider: ModelProviderConfig): ModelProviderConfig {
  if (!provider.models?.length) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

/**
 * Returns whether a provider transport can report native usage while streaming.
 */
export function supportsNativeStreamingUsageCompat(params: {
  /** Provider id used for transport capability lookup. */
  providerId: string;
  /** Provider endpoint URL used to detect native streaming usage behavior. */
  baseUrl: string | undefined;
}): boolean {
  return resolveProviderRequestCapabilities({
    provider: params.providerId,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    capability: "llm",
    transport: "stream",
  }).supportsNativeStreamingUsageCompat;
}

/**
 * Marks models as streaming-usage compatible when provider transport capabilities allow it.
 */
export function applyProviderNativeStreamingUsageCompat(params: {
  /** Provider id used for transport capability lookup. */
  providerId: string;
  /** Runtime provider config whose model compat flags may be filled in. */
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return supportsNativeStreamingUsageCompat({
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
  })
    ? withStreamingUsageCompat(params.providerConfig)
    : params.providerConfig;
}
