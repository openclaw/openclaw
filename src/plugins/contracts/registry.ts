import {
  BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  BUNDLED_PROVIDER_PLUGIN_IDS,
  BUNDLED_SPEECH_PLUGIN_IDS,
  BUNDLED_WEB_SEARCH_PLUGIN_IDS,
} from "../bundled-capability-metadata.js";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
  WebSearchProviderPlugin,
} from "../types.js";
import {
  loadVitestImageGenerationProviderContractRegistry,
  loadVitestMediaUnderstandingProviderContractRegistry,
  loadVitestSpeechProviderContractRegistry,
} from "./speech-vitest-registry.js";

type BundledCapabilityRuntimeRegistry = ReturnType<typeof loadBundledCapabilityRuntimeRegistry>;
type CapabilityContractEntry<T> = {
  pluginId: string;
  provider: T;
};

type ProviderContractEntry = CapabilityContractEntry<ProviderPlugin>;

type WebSearchProviderContractEntry = CapabilityContractEntry<WebSearchProviderPlugin> & {
  credentialValue: unknown;
};

type SpeechProviderContractEntry = CapabilityContractEntry<SpeechProviderPlugin>;
type MediaUnderstandingProviderContractEntry =
  CapabilityContractEntry<MediaUnderstandingProviderPlugin>;
type ImageGenerationProviderContractEntry = CapabilityContractEntry<ImageGenerationProviderPlugin>;

type PluginRegistrationContractEntry = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  speechProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

function createProviderContractPluginIdsByProviderId(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS) {
    for (const providerId of entry.providerIds) {
      const existing = result.get(providerId) ?? [];
      if (!existing.includes(entry.pluginId)) {
        existing.push(entry.pluginId);
      }
      result.set(providerId, existing);
    }
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

let providerContractRegistryCache: ProviderContractEntry[] | null = null;
let providerContractRegistryByPluginIdCache: Map<string, ProviderContractEntry[]> | null = null;
let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;
let webSearchProviderContractRegistryByPluginIdCache: Map<
  string,
  WebSearchProviderContractEntry[]
> | null = null;
let speechProviderContractRegistryCache: SpeechProviderContractEntry[] | null = null;
let mediaUnderstandingProviderContractRegistryCache:
  | MediaUnderstandingProviderContractEntry[]
  | null = null;
let imageGenerationProviderContractRegistryCache: ImageGenerationProviderContractEntry[] | null =
  null;
const providerContractPluginIdsByProviderId = createProviderContractPluginIdsByProviderId();

export let providerContractLoadError: Error | undefined;

function formatBundledCapabilityPluginLoadError(params: {
  pluginId: string;
  capabilityLabel: string;
  registry: BundledCapabilityRuntimeRegistry;
}): Error {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  const diagnostics = params.registry.diagnostics
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.message);
  const detailParts = plugin
    ? [
        `status=${plugin.status}`,
        ...(plugin.error ? [`error=${plugin.error}`] : []),
        `providerIds=[${plugin.providerIds.join(", ")}]`,
        `webSearchProviderIds=[${plugin.webSearchProviderIds.join(", ")}]`,
      ]
    : ["plugin record missing"];
  if (diagnostics.length > 0) {
    detailParts.push(`diagnostics=${diagnostics.join(" | ")}`);
  }
  return new Error(
    `bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: ${detailParts.join("; ")}`,
  );
}

function loadScopedCapabilityRuntimeRegistryEntries<T>(params: {
  pluginId: string;
  capabilityLabel: string;
  loadEntries: (registry: BundledCapabilityRuntimeRegistry) => T[];
  loadDeclaredIds: (
    plugin: BundledCapabilityRuntimeRegistry["plugins"][number],
  ) => readonly string[];
}): T[] {
  let lastFailure: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [params.pluginId],
      pluginSdkResolution: "dist",
    });
    const entries = params.loadEntries(registry);
    if (entries.length > 0) {
      return entries;
    }

    const plugin = registry.plugins.find((entry) => entry.id === params.pluginId);
    lastFailure = formatBundledCapabilityPluginLoadError({
      pluginId: params.pluginId,
      capabilityLabel: params.capabilityLabel,
      registry,
    });
    const shouldRetry =
      attempt === 0 &&
      (!plugin || plugin.status !== "loaded" || params.loadDeclaredIds(plugin).length === 0);
    if (!shouldRetry) {
      break;
    }
  }

  throw (
    lastFailure ??
    new Error(
      `bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: no entries`,
    )
  );
}

function loadProviderContractEntriesForPluginIds(
  pluginIds: readonly string[],
): ProviderContractEntry[] {
  return pluginIds.flatMap((pluginId) => loadProviderContractEntriesForPluginId(pluginId));
}

function loadProviderContractEntriesForPluginId(pluginId: string): ProviderContractEntry[] {
  if (providerContractRegistryCache) {
    return providerContractRegistryCache.filter((entry) => entry.pluginId === pluginId);
  }

  const cache =
    providerContractRegistryByPluginIdCache ?? new Map<string, ProviderContractEntry[]>();
  providerContractRegistryByPluginIdCache = cache;
  const cached = cache.get(pluginId);
  if (cached) {
    return cached;
  }

  try {
    providerContractLoadError = undefined;
    const entries = loadScopedCapabilityRuntimeRegistryEntries({
      pluginId,
      capabilityLabel: "provider",
      loadEntries: (registry) =>
        registry.providers
          .filter((entry) => entry.pluginId === pluginId)
          .map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
          })),
      loadDeclaredIds: (plugin) => plugin.providerIds,
    }).map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    }));
    cache.set(pluginId, entries);
    return entries;
  } catch (error) {
    providerContractLoadError = error instanceof Error ? error : new Error(String(error));
    cache.set(pluginId, []);
    return [];
  }
}

function loadProviderContractPluginIdsFromMetadata(): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.providerIds.length > 0).map(
    (entry) => entry.pluginId,
  );
}

function loadProviderContractRegistry(): ProviderContractEntry[] {
  if (!providerContractRegistryCache) {
    try {
      providerContractLoadError = undefined;
      providerContractRegistryCache = loadBundledCapabilityRuntimeRegistry({
        pluginIds: BUNDLED_PROVIDER_PLUGIN_IDS,
        pluginSdkResolution: process.env.VITEST ? "src" : "dist",
      }).providers.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      }));
    } catch (error) {
      providerContractLoadError = error instanceof Error ? error : new Error(String(error));
      providerContractRegistryCache = [];
    }
  }
  return providerContractRegistryCache;
}

export let webSearchProviderContractLoadError: Error | undefined;

function loadUniqueProviderContractProviders(): ProviderPlugin[] {
  return [
    ...new Map(
      loadProviderContractRegistry().map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

function loadProviderContractPluginIds(): string[] {
  if (process.env.VITEST) {
    return loadProviderContractPluginIdsFromMetadata();
  }
  return [...BUNDLED_PROVIDER_PLUGIN_IDS];
}

function loadProviderContractCompatPluginIds(): string[] {
  return loadProviderContractPluginIds();
}

function resolveWebSearchCredentialValue(provider: WebSearchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  if (envVar === "OPENROUTER_API_KEY") {
    return "openrouter-test";
  }
  return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}

function loadWebSearchProviderContractRegistry(): WebSearchProviderContractEntry[] {
  if (!webSearchProviderContractRegistryCache) {
    try {
      webSearchProviderContractLoadError = undefined;
      const registry = loadBundledCapabilityRuntimeRegistry({
        pluginIds: BUNDLED_WEB_SEARCH_PLUGIN_IDS,
        pluginSdkResolution: process.env.VITEST ? "src" : "dist",
      });
      webSearchProviderContractRegistryCache = registry.webSearchProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
        credentialValue: resolveWebSearchCredentialValue(entry.provider),
      }));
    } catch (error) {
      webSearchProviderContractLoadError =
        error instanceof Error ? error : new Error(String(error));
      webSearchProviderContractRegistryCache = [];
    }
  }
  return webSearchProviderContractRegistryCache;
}

export function resolveWebSearchProviderContractEntriesForPluginId(
  pluginId: string,
): WebSearchProviderContractEntry[] {
  if (webSearchProviderContractRegistryCache) {
    return webSearchProviderContractRegistryCache.filter((entry) => entry.pluginId === pluginId);
  }

  const cache =
    webSearchProviderContractRegistryByPluginIdCache ??
    new Map<string, WebSearchProviderContractEntry[]>();
  webSearchProviderContractRegistryByPluginIdCache = cache;
  const cached = cache.get(pluginId);
  if (cached) {
    return cached;
  }

  const entries = loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "web search provider",
    loadEntries: (registry) =>
      registry.webSearchProviders
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
          credentialValue: resolveWebSearchCredentialValue(entry.provider),
        })),
    loadDeclaredIds: (plugin) => plugin.webSearchProviderIds,
  });
  cache.set(pluginId, entries);
  return entries;
}

function loadSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  if (!speechProviderContractRegistryCache) {
    speechProviderContractRegistryCache = process.env.VITEST
      ? loadVitestSpeechProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: BUNDLED_SPEECH_PLUGIN_IDS,
          pluginSdkResolution: "dist",
        }).speechProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return speechProviderContractRegistryCache;
}

function loadMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  if (!mediaUnderstandingProviderContractRegistryCache) {
    mediaUnderstandingProviderContractRegistryCache = process.env.VITEST
      ? loadVitestMediaUnderstandingProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
          pluginSdkResolution: "dist",
        }).mediaUnderstandingProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return mediaUnderstandingProviderContractRegistryCache;
}

function loadImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  if (!imageGenerationProviderContractRegistryCache) {
    imageGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestImageGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
          pluginSdkResolution: "dist",
        }).imageGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return imageGenerationProviderContractRegistryCache;
}

function createLazyArrayView<T>(load: () => T[]): T[] {
  return new Proxy([] as T[], {
    get(_target, prop) {
      const actual = load();
      const value = Reflect.get(actual, prop, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
    has(_target, prop) {
      return Reflect.has(load(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const actual = load();
      const descriptor = Reflect.getOwnPropertyDescriptor(actual, prop);
      if (descriptor) {
        return descriptor;
      }
      if (Reflect.has(actual, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Reflect.get(actual, prop, actual),
        };
      }
      return undefined;
    },
  });
}

export const providerContractRegistry: ProviderContractEntry[] = createLazyArrayView(
  loadProviderContractRegistry,
);

export const uniqueProviderContractProviders: ProviderPlugin[] = createLazyArrayView(
  loadUniqueProviderContractProviders,
);

export const providerContractPluginIds: string[] = createLazyArrayView(
  loadProviderContractPluginIds,
);

export const providerContractCompatPluginIds: string[] = createLazyArrayView(
  loadProviderContractCompatPluginIds,
);

export function requireProviderContractProvider(providerId: string): ProviderPlugin {
  const pluginIds = providerContractPluginIdsByProviderId.get(providerId) ?? [];
  const entries = loadProviderContractEntriesForPluginIds(pluginIds);
  const provider = entries.find((entry) => entry.provider.id === providerId)?.provider;
  if (!provider) {
    const pluginScopedProviders = [
      ...new Map(entries.map((entry) => [entry.provider.id, entry.provider])).values(),
    ];
    // Paired catalogs may expose multiple runtime provider ids from one shared
    // ProviderPlugin contract entry. Reuse that single contract surface for the
    // manifest-owned alias ids instead of requiring duplicate registration.
    if (pluginIds.length === 1 && pluginScopedProviders.length === 1) {
      return pluginScopedProviders[0];
    }
    if (providerContractLoadError) {
      throw new Error(
        `provider contract entry missing for ${providerId}; bundled provider registry failed to load: ${providerContractLoadError.message}`,
      );
    }
    throw new Error(`provider contract entry missing for ${providerId}`);
  }
  return provider;
}

export function resolveProviderContractPluginIdsForProvider(
  providerId: string,
): string[] | undefined {
  const pluginIds = providerContractPluginIdsByProviderId.get(providerId) ?? [];
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderContractProvidersForPluginIds(
  pluginIds: readonly string[],
): ProviderPlugin[] {
  const allowed = new Set(pluginIds);
  return [
    ...new Map(
      loadProviderContractEntriesForPluginIds([...allowed])
        .filter((entry) => allowed.has(entry.pluginId))
        .map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

export const webSearchProviderContractRegistry: WebSearchProviderContractEntry[] =
  createLazyArrayView(loadWebSearchProviderContractRegistry);

export const speechProviderContractRegistry: SpeechProviderContractEntry[] = createLazyArrayView(
  loadSpeechProviderContractRegistry,
);

export const mediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  createLazyArrayView(loadMediaUnderstandingProviderContractRegistry);

export const imageGenerationProviderContractRegistry: ImageGenerationProviderContractEntry[] =
  createLazyArrayView(loadImageGenerationProviderContractRegistry);

function loadPluginRegistrationContractRegistry(): PluginRegistrationContractEntry[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => ({
    pluginId: entry.pluginId,
    cliBackendIds: uniqueStrings(entry.cliBackendIds),
    providerIds: uniqueStrings(entry.providerIds),
    speechProviderIds: uniqueStrings(entry.speechProviderIds),
    mediaUnderstandingProviderIds: uniqueStrings(entry.mediaUnderstandingProviderIds),
    imageGenerationProviderIds: uniqueStrings(entry.imageGenerationProviderIds),
    webSearchProviderIds: uniqueStrings(entry.webSearchProviderIds),
    toolNames: uniqueStrings(entry.toolNames),
  }));
}

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  createLazyArrayView(loadPluginRegistrationContractRegistry);
