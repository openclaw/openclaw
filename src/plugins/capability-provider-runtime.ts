import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry-types.js";

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
  const allowlistCompat = withBundledPluginAllowlistCompat({
    config: params.cfg,
    pluginIds,
  });
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
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
  // Without cfg there is no allowlist to apply — use the active registry directly,
  // falling back to the compat path only if the active registry is empty.
  if (!params.cfg) {
    if (activeProviders.length > 0) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
    const compatConfig = resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg });
    const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig };
    const registry = resolveRuntimePluginRegistry(loadOptions);
    return (registry?.[params.key] ?? []).map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  // When cfg is provided, run the compat path to discover all allowlisted bundled providers
  // (e.g. "microsoft" Edge TTS), then merge with any active providers not already present
  // so that runtime-registered providers from workspace plugins are preserved.
  const compatConfig = resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg });
  const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig };
  const compatRegistry = resolveRuntimePluginRegistry(loadOptions);
  const compatProviders = (compatRegistry?.[params.key] ?? []).map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
  if (compatProviders.length === 0) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  // Merge: compat providers first, then any active-only providers not covered by compat.
  const compatIds = new Set(compatProviders.map((p) => (p as { id: string }).id));
  const activeOnlyProviders = activeProviders
    .filter((entry) => !compatIds.has((entry.provider as { id: string }).id))
    .map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  return [...compatProviders, ...activeOnlyProviders];
}
