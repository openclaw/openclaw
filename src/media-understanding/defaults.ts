// Media-understanding default model/provider selection from config, manifest
// metadata, and capability declarations.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { configuredModelInputSupportsImage } from "./known-model-capabilities.js";
import { buildMediaUnderstandingManifestMetadataRegistry } from "./manifest-metadata.js";
import { knownProviderModelCapabilities } from "./model-capability-overrides.js";
import {
  normalizeMediaExecutionProviderId,
  normalizeMediaProviderId,
} from "./provider-registry.js";
import { providerSupportsCapability } from "./provider-supports.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_CHARS_BY_CAPABILITY,
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_VIDEO_MAX_BASE64_BYTES,
  MIN_AUDIO_FILE_BYTES,
} from "./defaults.constants.js";

let defaultRegistryCache: ReadonlyMap<string, MediaUnderstandingProvider> | null = null;
const configRegistryCache = new Map<string, ReadonlyMap<string, MediaUnderstandingProvider>>();
const MAX_CONFIG_REGISTRY_CACHE_ENTRIES = 32;

function cacheConfigRegistry(
  key: string,
  registry: ReadonlyMap<string, MediaUnderstandingProvider>,
): ReadonlyMap<string, MediaUnderstandingProvider> {
  // Config snapshots are process-stable enough for bounded reuse; cap entries so
  // tests and multi-workspace runs cannot grow this cache without limit.
  if (
    !configRegistryCache.has(key) &&
    configRegistryCache.size >= MAX_CONFIG_REGISTRY_CACHE_ENTRIES
  ) {
    const oldestKey = configRegistryCache.keys().next().value;
    if (oldestKey) {
      configRegistryCache.delete(oldestKey);
    }
  }
  configRegistryCache.set(key, registry);
  return registry;
}

function resolveDefaultRegistry(cfg?: OpenClawConfig, workspaceDir?: string) {
  if (!cfg) {
    defaultRegistryCache ??= buildMediaUnderstandingManifestMetadataRegistry();
    return defaultRegistryCache;
  }
  const cacheKey = `${resolveRuntimeConfigCacheKey(cfg)}:${workspaceDir ?? ""}`;
  const cached = configRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const registry = buildMediaUnderstandingManifestMetadataRegistry(cfg, workspaceDir);
  return cacheConfigRegistry(cacheKey, registry);
}

function providerHasDeclaredCapability(
  provider: MediaUnderstandingProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  return (
    provider?.capabilities?.includes(capability) ?? providerSupportsCapability(provider, capability)
  );
}

function resolveConfiguredImageProviderModel(params: {
  cfg?: OpenClawConfig;
  providerId: string;
  registry: ReadonlyMap<string, MediaUnderstandingProvider>;
}): string | undefined {
  const normalizedProviderId = normalizeMediaProviderId(params.providerId);
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    if (normalizeMediaProviderId(providerKey) !== normalizedProviderId) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const match = models.find((model) => {
      const id = normalizeOptionalString(model?.id);
      return Boolean(
        id &&
        configuredModelInputSupportsImage({
          modelId: id,
          input: model?.input,
          provider:
            params.registry.get(normalizeMediaProviderId(providerKey)) ??
            knownProviderModelCapabilities(providerKey),
        }),
      );
    });
    return normalizeOptionalString(match?.id);
  }
  return undefined;
}

function resolveConfiguredImageProviderIds(params: {
  cfg?: OpenClawConfig;
  registry: ReadonlyMap<string, MediaUnderstandingProvider>;
}): string[] {
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const configured: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    const normalizedProviderId = normalizeMediaExecutionProviderId(providerKey);
    if (!normalizedProviderId || configured.includes(normalizedProviderId)) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const hasImageModel = models.some((model) => {
      const id = normalizeOptionalString(model?.id);
      return Boolean(
        id &&
        configuredModelInputSupportsImage({
          modelId: id,
          input: model?.input,
          provider:
            params.registry.get(normalizeMediaProviderId(providerKey)) ??
            knownProviderModelCapabilities(providerKey),
        }),
      );
    });
    if (hasImageModel) {
      configured.push(normalizedProviderId);
    }
  }
  return configured;
}

function isExecutionAliasProvider(providerId: string): boolean {
  return normalizeMediaProviderId(providerId) !== providerId;
}

function insertConfiguredImageProviders(params: {
  prioritized: string[];
  configured: string[];
}): string[] {
  const merged = [...params.prioritized];
  for (const providerId of params.configured.filter(isExecutionAliasProvider)) {
    const canonicalProviderId = normalizeMediaProviderId(providerId);
    const canonicalIndex = merged.indexOf(canonicalProviderId);
    if (canonicalIndex >= 0) {
      merged.splice(canonicalIndex, 0, providerId);
    } else {
      merged.unshift(providerId);
    }
  }
  for (const providerId of params.configured.filter((id) => !isExecutionAliasProvider(id))) {
    merged.push(providerId);
  }
  return uniqueStrings(merged);
}

/** Resolves the default provider model for a media capability from config or manifest metadata. */
export function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: ReadonlyMap<string, MediaUnderstandingProvider>;
  includeConfiguredImageModels?: boolean;
}): string | undefined {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  if (params.includeConfiguredImageModels !== false) {
    const configuredImageModel =
      params.capability === "image"
        ? resolveConfiguredImageProviderModel({
            cfg: params.cfg,
            providerId: params.providerId,
            registry,
          })
        : undefined;
    if (configuredImageModel) {
      return configuredImageModel;
    }
  }
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  const manifestDefaultModel = normalizeOptionalString(
    provider?.defaultModels?.[params.capability],
  );
  if (manifestDefaultModel) {
    return manifestDefaultModel;
  }
  return undefined;
}

/** Resolves auto-discovery provider order for a media capability using manifest priorities. */
export function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: ReadonlyMap<string, MediaUnderstandingProvider>;
}): string[] {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  type AutoProviderEntry = {
    provider: MediaUnderstandingProvider;
    priority: number;
  };
  const prioritized = [...registry.values()]
    .filter((provider) => providerHasDeclaredCapability(provider, params.capability))
    .map((provider): AutoProviderEntry | null => {
      const priority = provider.autoPriority?.[params.capability];
      return typeof priority === "number" && Number.isFinite(priority)
        ? { provider, priority }
        : null;
    })
    .filter((entry): entry is AutoProviderEntry => entry !== null)
    .toSorted((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.provider.id.localeCompare(right.provider.id);
    })
    .map((entry) => normalizeMediaProviderId(entry.provider.id))
    .filter(Boolean);
  if (params.providerRegistry || params.capability !== "image") {
    return prioritized;
  }
  return insertConfiguredImageProviders({
    prioritized,
    configured: resolveConfiguredImageProviderIds({ cfg: params.cfg, registry }),
  });
}

/** Returns whether provider metadata declares native PDF document input support. */
export function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: ReadonlyMap<string, MediaUnderstandingProvider>;
}): boolean {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return provider?.nativeDocumentInputs?.includes("pdf") ?? false;
}

/** Resolves provider-specific document model hints, preserving explicit unsupported markers. */
export function resolveDocumentMediaModel(params: {
  providerId: string;
  document: "pdf";
  mode: "textExtraction" | "image";
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: ReadonlyMap<string, MediaUnderstandingProvider>;
}): string | false | undefined {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  const value = provider?.documentModels?.[params.document]?.[params.mode];
  if (value === false) {
    return false;
  }
  return normalizeOptionalString(value);
}
