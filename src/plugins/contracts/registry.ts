import { bundledWebSearchPluginRegistrations } from "../../bundled-web-search-registry.js";
import { BUNDLED_PLUGIN_ENTRIES } from "../bundled-plugin-entries.js";
import { createCapturedPluginRegistration } from "../captured-registration.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
  WebSearchProviderPlugin,
} from "../types.js";

type RegistrablePlugin = {
  id: string;
  register: (api: ReturnType<typeof createCapturedPluginRegistration>["api"]) => void;
};

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

const bundledWebSearchPlugins: Array<RegistrablePlugin & { credentialValue: unknown }> =
  bundledWebSearchPluginRegistrations.map(({ plugin, credentialValue }) => ({
    ...plugin,
    credentialValue,
  }));

function captureRegistrations(plugin: RegistrablePlugin) {
  const captured = createCapturedPluginRegistration();
  plugin.register(captured.api);
  return captured;
}

function buildCapabilityContractRegistry<T>(params: {
  plugins: RegistrablePlugin[];
  select: (captured: ReturnType<typeof createCapturedPluginRegistration>) => T[];
}): CapabilityContractEntry<T>[] {
  return params.plugins.flatMap((plugin) => {
    const captured = captureRegistrations(plugin);
    return params.select(captured).map((provider) => ({
      pluginId: plugin.id,
      provider,
    }));
  });
}

function dedupePlugins<T extends RegistrablePlugin>(
  plugins: ReadonlyArray<T | undefined | null>,
): T[] {
  return [
    ...new Map(
      plugins.filter((plugin): plugin is T => Boolean(plugin)).map((plugin) => [plugin.id, plugin]),
    ).values(),
  ];
}

export let providerContractLoadError: Error | undefined;

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

let providerContractRegistryCache: ProviderContractEntry[] | null = null;
let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;
let speechProviderContractRegistryCache: SpeechProviderContractEntry[] | null = null;
let mediaUnderstandingProviderContractRegistryCache:
  | MediaUnderstandingProviderContractEntry[]
  | null = null;
let imageGenerationProviderContractRegistryCache: ImageGenerationProviderContractEntry[] | null =
  null;
let pluginRegistrationContractRegistryCache: PluginRegistrationContractEntry[] | null = null;

function loadProviderContractRegistry(): ProviderContractEntry[] {
  if (!providerContractRegistryCache) {
    try {
      providerContractLoadError = undefined;
      providerContractRegistryCache = buildCapabilityContractRegistry({
        plugins: bundledProviderPlugins,
        select: (captured) => captured.providers,
      }).map((entry) => ({
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

function loadUniqueProviderContractProviders(): ProviderPlugin[] {
  return [
    ...new Map(
      loadProviderContractRegistry().map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

function loadProviderContractPluginIds(): string[] {
  return [...new Set(loadProviderContractRegistry().map((entry) => entry.pluginId))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function loadProviderContractCompatPluginIds(): string[] {
  return loadProviderContractPluginIds().map((pluginId) =>
    pluginId === "kimi-coding" ? "kimi" : pluginId,
  );
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
    if (!providerContractLoadError) {
      loadProviderContractRegistry();
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

function loadWebSearchProviderContractRegistry(): WebSearchProviderContractEntry[] {
  if (!webSearchProviderContractRegistryCache) {
    webSearchProviderContractRegistryCache = bundledWebSearchPlugins.flatMap((plugin) => {
      const captured = captureRegistrations(plugin);
      return captured.webSearchProviders.map((provider) => ({
        pluginId: plugin.id,
        provider,
        credentialValue: plugin.credentialValue,
      }));
    });
  }
  return webSearchProviderContractRegistryCache;
}

function loadSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  if (!speechProviderContractRegistryCache) {
    speechProviderContractRegistryCache = buildCapabilityContractRegistry({
      plugins: bundledSpeechPlugins,
      select: (captured) => captured.speechProviders,
    });
  }
  return speechProviderContractRegistryCache;
}

function loadMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  if (!mediaUnderstandingProviderContractRegistryCache) {
    mediaUnderstandingProviderContractRegistryCache = buildCapabilityContractRegistry({
      plugins: bundledMediaUnderstandingPlugins,
      select: (captured) => captured.mediaUnderstandingProviders,
    });
  }
  return mediaUnderstandingProviderContractRegistryCache;
}

function loadImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  if (!imageGenerationProviderContractRegistryCache) {
    imageGenerationProviderContractRegistryCache = buildCapabilityContractRegistry({
      plugins: bundledImageGenerationPlugins,
      select: (captured) => captured.imageGenerationProviders,
    });
  }
  return imageGenerationProviderContractRegistryCache;
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

const bundledRegistrablePluginsById = new Map(
  dedupePlugins([...BUNDLED_PLUGIN_ENTRIES, ...bundledWebSearchPlugins]).map((plugin) => [
    plugin.id,
    plugin,
  ]),
);

function resolveBundledManifestPluginIds(
  predicate: (plugin: ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]) => boolean,
): string[] {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled" && predicate(plugin))
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveBundledRegistrablePlugins(
  predicate: (plugin: ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]) => boolean,
): RegistrablePlugin[] {
  return resolveBundledManifestPluginIds(predicate).flatMap((pluginId) => {
    const plugin = bundledRegistrablePluginsById.get(pluginId);
    return plugin ? [plugin] : [];
  });
}

const bundledProviderPlugins = resolveBundledRegistrablePlugins(
  (plugin) => plugin.providers.length > 0,
);
const bundledSpeechPlugins = resolveBundledRegistrablePlugins(
  (plugin) => (plugin.speechProviders?.length ?? 0) > 0,
);
const bundledMediaUnderstandingPlugins = resolveBundledRegistrablePlugins(
  (plugin) => (plugin.mediaUnderstandingProviders?.length ?? 0) > 0,
);
const bundledImageGenerationPlugins = resolveBundledRegistrablePlugins(
  (plugin) => (plugin.imageGenerationProviders?.length ?? 0) > 0,
);

const bundledPluginRegistrationList = dedupePlugins([
  ...bundledProviderPlugins,
  ...bundledSpeechPlugins,
  ...bundledMediaUnderstandingPlugins,
  ...bundledImageGenerationPlugins,
  ...bundledWebSearchPlugins,
]);

function upsertPluginRegistrationContractEntry(
  entries: PluginRegistrationContractEntry[],
  next: PluginRegistrationContractEntry,
): void {
  const existing = entries.find((entry) => entry.pluginId === next.pluginId);
  if (!existing) {
    entries.push(next);
    return;
  }
  existing.cliBackendIds = [
    ...new Set([...existing.cliBackendIds, ...next.cliBackendIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  existing.providerIds = [...new Set([...existing.providerIds, ...next.providerIds])].toSorted(
    (left, right) => left.localeCompare(right),
  );
  existing.speechProviderIds = [
    ...new Set([...existing.speechProviderIds, ...next.speechProviderIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  existing.mediaUnderstandingProviderIds = [
    ...new Set([...existing.mediaUnderstandingProviderIds, ...next.mediaUnderstandingProviderIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  existing.imageGenerationProviderIds = [
    ...new Set([...existing.imageGenerationProviderIds, ...next.imageGenerationProviderIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  existing.webSearchProviderIds = [
    ...new Set([...existing.webSearchProviderIds, ...next.webSearchProviderIds]),
  ].toSorted((left, right) => left.localeCompare(right));
  existing.toolNames = [...new Set([...existing.toolNames, ...next.toolNames])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function loadPluginRegistrationContractRegistry(): PluginRegistrationContractEntry[] {
  if (!pluginRegistrationContractRegistryCache) {
    const entries: PluginRegistrationContractEntry[] = [];
    for (const plugin of bundledPluginRegistrationList) {
      const captured = captureRegistrations(plugin);
      upsertPluginRegistrationContractEntry(entries, {
        pluginId: plugin.id,
        cliBackendIds: captured.cliBackends.map((backend) => backend.id),
        providerIds: captured.providers.map((provider) => provider.id),
        speechProviderIds: captured.speechProviders.map((provider) => provider.id),
        mediaUnderstandingProviderIds: captured.mediaUnderstandingProviders.map(
          (provider) => provider.id,
        ),
        imageGenerationProviderIds: captured.imageGenerationProviders.map(
          (provider) => provider.id,
        ),
        webSearchProviderIds: captured.webSearchProviders.map((provider) => provider.id),
        toolNames: captured.tools.map((tool) => tool.name),
      });
    }
    pluginRegistrationContractRegistryCache = entries;
  }
  return pluginRegistrationContractRegistryCache;
}

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  createLazyArrayView(loadPluginRegistrationContractRegistry);
