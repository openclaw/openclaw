import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withBundledPluginEnablementCompat } from "../bundled-compat.js";
import { resolveBundledWebSearchPluginIds } from "../bundled-web-search.js";
import { loadOpenClawPlugins } from "../loader.js";
import { createPluginLoaderLogger } from "../logger.js";
import { resolvePluginProviders } from "../providers.js";
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
  providerIds: string[];
  speechProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

const log = createSubsystemLogger("plugins");

const BUNDLED_WEB_SEARCH_CREDENTIAL_VALUES: Readonly<Record<string, unknown>> = {
  brave: "BSA-test",
  firecrawl: "fc-test",
  google: "AIza-test",
  moonshot: "sk-test",
  perplexity: "pplx-test",
  xai: "xai-test",
};

const BUNDLED_SPEECH_PLUGIN_IDS = ["elevenlabs", "microsoft", "openai"] as const;
const BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS = [
  "anthropic",
  "google",
  "minimax",
  "mistral",
  "moonshot",
  "openai",
  "zai",
] as const;
const BUNDLED_IMAGE_GENERATION_PLUGIN_IDS = ["fal", "google", "openai"] as const;

export const providerContractRegistry: ProviderContractEntry[] = [];

export let providerContractLoadError: Error | undefined;

function loadBundledProviderRegistry(): ProviderContractEntry[] {
  try {
    providerContractLoadError = undefined;
    return resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
      cache: false,
      activate: false,
    })
      .filter((provider): provider is ProviderPlugin & { pluginId: string } =>
        Boolean(provider.pluginId),
      )
      .map((provider) => ({
        pluginId: provider.pluginId,
        provider,
      }));
  } catch (error) {
    providerContractLoadError = error instanceof Error ? error : new Error(String(error));
    return [];
  }
}

const loadedBundledProviderRegistry: ProviderContractEntry[] = loadBundledProviderRegistry();

providerContractRegistry.splice(
  0,
  providerContractRegistry.length,
  ...loadedBundledProviderRegistry,
);

export const uniqueProviderContractProviders: ProviderPlugin[] = [
  ...new Map(providerContractRegistry.map((entry) => [entry.provider.id, entry.provider])).values(),
];

export const providerContractPluginIds = [
  ...new Set(providerContractRegistry.map((entry) => entry.pluginId)),
].toSorted((left, right) => left.localeCompare(right));

export const providerContractCompatPluginIds = providerContractPluginIds.map((pluginId) =>
  pluginId === "kimi-coding" ? "kimi" : pluginId,
);

const bundledCapabilityContractPluginIds = [
  ...new Set([
    ...providerContractCompatPluginIds,
    ...resolveBundledWebSearchPluginIds({}),
    ...BUNDLED_SPEECH_PLUGIN_IDS,
    ...BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
    ...BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  ]),
].toSorted((left, right) => left.localeCompare(right));

export let capabilityContractLoadError: Error | undefined;

function loadBundledCapabilityRegistry() {
  try {
    capabilityContractLoadError = undefined;
    return loadOpenClawPlugins({
      config: withBundledPluginEnablementCompat({
        config: {
          plugins: {
            enabled: true,
            allow: bundledCapabilityContractPluginIds,
            slots: {
              memory: "none",
            },
          },
        },
        pluginIds: bundledCapabilityContractPluginIds,
      }),
      cache: false,
      activate: false,
      logger: createPluginLoaderLogger(log),
    });
  } catch (error) {
    capabilityContractLoadError = error instanceof Error ? error : new Error(String(error));
    return loadOpenClawPlugins({
      config: {
        plugins: {
          enabled: false,
        },
      },
      cache: false,
      activate: false,
      logger: createPluginLoaderLogger(log),
    });
  }
}

const loadedBundledCapabilityRegistry = loadBundledCapabilityRegistry();

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
  loadedBundledCapabilityRegistry.webSearchProviders
    .filter((entry) => entry.pluginId in BUNDLED_WEB_SEARCH_CREDENTIAL_VALUES)
    .map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
      credentialValue: BUNDLED_WEB_SEARCH_CREDENTIAL_VALUES[entry.pluginId],
    }));

export const speechProviderContractRegistry: SpeechProviderContractEntry[] =
  loadedBundledCapabilityRegistry.speechProviders.map((entry) => ({
    pluginId: entry.pluginId,
    provider: entry.provider,
  }));

export const mediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  loadedBundledCapabilityRegistry.mediaUnderstandingProviders.map((entry) => ({
    pluginId: entry.pluginId,
    provider: entry.provider,
  }));

export const imageGenerationProviderContractRegistry: ImageGenerationProviderContractEntry[] =
  loadedBundledCapabilityRegistry.imageGenerationProviders.map((entry) => ({
    pluginId: entry.pluginId,
    provider: entry.provider,
  }));

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  loadedBundledCapabilityRegistry.plugins
    .filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.providerIds.length > 0 ||
          plugin.speechProviderIds.length > 0 ||
          plugin.mediaUnderstandingProviderIds.length > 0 ||
          plugin.imageGenerationProviderIds.length > 0 ||
          plugin.webSearchProviderIds.length > 0 ||
          plugin.toolNames.length > 0),
    )
    .map((plugin) => ({
      pluginId: plugin.id,
      providerIds: plugin.providerIds,
      speechProviderIds: plugin.speechProviderIds,
      mediaUnderstandingProviderIds: plugin.mediaUnderstandingProviderIds,
      imageGenerationProviderIds: plugin.imageGenerationProviderIds,
      webSearchProviderIds: plugin.webSearchProviderIds,
      toolNames: plugin.toolNames,
    }));
