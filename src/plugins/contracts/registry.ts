import { listBundledImageGenerationProviderEntries } from "../../bundled-image-generation-providers.js";
import {
  BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  BUNDLED_PROVIDER_PLUGIN_IDS,
  BUNDLED_WEB_SEARCH_PLUGIN_IDS,
} from "../bundled-capability-metadata.js";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { resolvePluginProviders } from "../providers.runtime.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
  WebSearchProviderPlugin,
} from "../types.js";

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

function createContractSpeechProvider(providerId: string): SpeechProviderPlugin {
  return {
    id: providerId,
    label: providerId,
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.alloc(0),
      outputFormat: "mp3",
      fileExtension: "mp3",
      voiceCompatible: true,
    }),
    listVoices: async () => [],
  };
}

function createContractMediaUnderstandingProvider(
  providerId: string,
): MediaUnderstandingProviderPlugin {
  return {
    id: providerId,
    capabilities: ["image"],
    describeImages: async () => {
      throw new Error(`media-understanding contract stub invoked for ${providerId}`);
    },
  };
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
let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;
let speechProviderContractRegistryCache: SpeechProviderContractEntry[] | null = null;
let mediaUnderstandingProviderContractRegistryCache:
  | MediaUnderstandingProviderContractEntry[]
  | null = null;
let imageGenerationProviderContractRegistryCache: ImageGenerationProviderContractEntry[] | null =
  null;
const providerContractPluginIdsByProviderId = createProviderContractPluginIdsByProviderId();
const providerContractEntriesByPluginId = new Map<string, ProviderContractEntry[]>();

export let providerContractLoadError: Error | undefined;

function loadProviderContractEntriesForPluginId(pluginId: string): ProviderContractEntry[] {
  const cached = providerContractEntriesByPluginId.get(pluginId);
  if (cached) {
    return cached;
  }
  try {
    providerContractLoadError = undefined;
    const entries = resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
      onlyPluginIds: [pluginId],
      cache: false,
      activate: false,
    }).map((provider) => ({
      pluginId: provider.pluginId ?? pluginId,
      provider,
    }));
    providerContractEntriesByPluginId.set(pluginId, entries);
    return entries;
  } catch (error) {
    providerContractLoadError = error instanceof Error ? error : new Error(String(error));
    providerContractEntriesByPluginId.set(pluginId, []);
    return [];
  }
}

function loadProviderContractEntriesForPluginIds(
  pluginIds: readonly string[],
): ProviderContractEntry[] {
  return pluginIds.flatMap((pluginId) => loadProviderContractEntriesForPluginId(pluginId));
}

function loadProviderContractRegistry(): ProviderContractEntry[] {
  if (!providerContractRegistryCache) {
    providerContractRegistryCache = loadProviderContractEntriesForPluginIds(
      BUNDLED_PROVIDER_PLUGIN_IDS,
    );
  }
  return providerContractRegistryCache;
}

function loadUniqueProviderContractProviders(): ProviderPlugin[] {
  return [
    ...new Map(
      loadProviderContractRegistry().map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

function loadProviderContractPluginIds(): string[] {
  return [...BUNDLED_PROVIDER_PLUGIN_IDS];
}

function loadProviderContractCompatPluginIds(): string[] {
  return loadProviderContractPluginIds().map((pluginId) =>
    pluginId === "kimi-coding" ? "kimi" : pluginId,
  );
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
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_WEB_SEARCH_PLUGIN_IDS,
    });
    webSearchProviderContractRegistryCache = registry.webSearchProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
      credentialValue: resolveWebSearchCredentialValue(entry.provider),
    }));
  }
  return webSearchProviderContractRegistryCache;
}

function loadSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  if (!speechProviderContractRegistryCache) {
    // Contract tests only need bundled ownership and public speech surface shape.
    speechProviderContractRegistryCache = BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
      entry.speechProviderIds.map((providerId) => ({
        pluginId: entry.pluginId,
        provider: createContractSpeechProvider(providerId),
      })),
    );
  }
  return speechProviderContractRegistryCache;
}

function loadMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  if (!mediaUnderstandingProviderContractRegistryCache) {
    mediaUnderstandingProviderContractRegistryCache = BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap(
      (entry) =>
        entry.mediaUnderstandingProviderIds.map((providerId) => ({
          pluginId: entry.pluginId,
          provider: createContractMediaUnderstandingProvider(providerId),
        })),
    );
  }
  return mediaUnderstandingProviderContractRegistryCache;
}

function loadImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  if (!imageGenerationProviderContractRegistryCache) {
    imageGenerationProviderContractRegistryCache =
      listBundledImageGenerationProviderEntries().filter((entry) =>
        BUNDLED_IMAGE_GENERATION_PLUGIN_IDS.includes(entry.pluginId),
      );
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
  const provider = loadProviderContractEntriesForPluginIds(
    providerContractPluginIdsByProviderId.get(providerId) ?? [],
  ).find((entry) => entry.provider.id === providerId)?.provider;
  if (!provider) {
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
