import type { OpenClawConfig } from "../config/config.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry.js";

type CapabilityProviderRegistryKey =
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type CapabilityContractKey =
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;

const CAPABILITY_CONTRACT_KEY: Record<CapabilityProviderRegistryKey, CapabilityContractKey> = {
  memoryEmbeddingProviders: "memoryEmbeddingProviders",
  speechProviders: "speechProviders",
  realtimeTranscriptionProviders: "realtimeTranscriptionProviders",
  realtimeVoiceProviders: "realtimeVoiceProviders",
  mediaUnderstandingProviders: "mediaUnderstandingProviders",
  imageGenerationProviders: "imageGenerationProviders",
  videoGenerationProviders: "videoGenerationProviders",
  musicGenerationProviders: "musicGenerationProviders",
};

function resolveBundledCapabilityCompatPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): string[] {
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  return loadPluginManifestRegistry({
    config: params.cfg,
    env: process.env,
  })
    .plugins.filter(
      (plugin) => plugin.origin === "bundled" && (plugin.contracts?.[contractKey]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveCapabilityProviderConfig(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}) {
  const pluginIds = resolveBundledCapabilityCompatPluginIds(params);
  const enablementCompat = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env: process.env,
  });
}

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
}): CapabilityProviderForKey<K>[] {
  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];
  const mappedActiveProviders = activeProviders.map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
  if (activeProviders.length > 0 && params.cfg === undefined) {
    return mappedActiveProviders;
  }
  const compatConfig = resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg });
  const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig };
  const registry = resolveRuntimePluginRegistry(loadOptions);
  const compatProviders = (registry?.[params.key] ?? []).map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
  if (mappedActiveProviders.length === 0) {
    return compatProviders;
  }
  const mergedProviders = [...mappedActiveProviders];
  const seen = new Set(mappedActiveProviders.map((provider) => provider.id));
  for (const provider of compatProviders) {
    if (seen.has(provider.id)) {
      continue;
    }
    seen.add(provider.id);
    mergedProviders.push(provider);
  }
  return mergedProviders;
}
