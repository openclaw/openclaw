import {
  BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  BUNDLED_PROVIDER_PLUGIN_IDS,
  BUNDLED_SPEECH_PLUGIN_IDS,
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

export let providerContractLoadError: Error | undefined;

function loadProviderContractRegistry(): ProviderContractEntry[] {
  if (!providerContractRegistryCache) {
    try {
      providerContractLoadError = undefined;
      providerContractRegistryCache = resolvePluginProviders({
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
        onlyPluginIds: [...BUNDLED_PROVIDER_PLUGIN_IDS],
        cache: false,
        activate: false,
      }).map((provider) => ({
        pluginId: provider.pluginId ?? "",
        provider,
      }));
    } catch (error) {
      providerContractLoadError = error instanceof Error ? error : new Error(String(error));
      providerContractRegistryCache = [];
    }
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
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_SPEECH_PLUGIN_IDS,
    });
    speechProviderContractRegistryCache = registry.speechProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    }));
  }
  return speechProviderContractRegistryCache;
}

function loadMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  if (!mediaUnderstandingProviderContractRegistryCache) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
    });
    mediaUnderstandingProviderContractRegistryCache = registry.mediaUnderstandingProviders.map(
      (entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      }),
    );
  }
  return mediaUnderstandingProviderContractRegistryCache;
}

function loadImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  if (!imageGenerationProviderContractRegistryCache) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
    });
    imageGenerationProviderContractRegistryCache = registry.imageGenerationProviders.map(
      (entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      }),
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
  const provider = uniqueProviderContractProviders.find((entry) => entry.id === providerId);
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
  const pluginIds = [
    ...new Set(
      providerContractRegistry
        .filter((entry) => entry.provider.id === providerId)
        .map((entry) => entry.pluginId),
    ),
  ];
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderContractProvidersForPluginIds(
  pluginIds: readonly string[],
): ProviderPlugin[] {
  const allowed = new Set(pluginIds);
  return [
    ...new Map(
      providerContractRegistry
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
