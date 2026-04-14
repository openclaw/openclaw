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
  // The compat path is only meaningful when there is an explicit plugins.allow list to
  // expand against.  Without it, withBundledPluginAllowlistCompat would add every bundled
  // provider for the capability to the allow set, injecting providers (e.g. elevenlabs)
  // that were never configured by the user.  When there is no allow list — or when the
  // active registry is already empty and would naturally fall through to the compat path
  // anyway — use the original behaviour.
  if (activeProviders.length > 0 && !params.cfg?.plugins?.allow?.length) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  // Run the compat path to discover allowlisted bundled providers (e.g. "microsoft" Edge
  // TTS) that were not self-registered at startup because another provider (e.g. "openai")
  // registered first via a different capability code path and caused the early-return above
  // to fire on previous runs.
  const compatConfig = resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg });
  const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig };
  const compatRegistry = resolveRuntimePluginRegistry(loadOptions);
  const compatProviders = (compatRegistry?.[params.key] ?? []).map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
  if (compatProviders.length === 0) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  // Merge: compat-discovered providers first (respects the allowlist ordering), then any
  // active-only providers not already present (e.g. workspace-plugin-registered providers
  // that are not in the bundled manifest).
  const compatIds = new Set(compatProviders.map((p) => (p as { id: string }).id));
  const activeOnlyProviders = activeProviders
    .filter((entry) => !compatIds.has((entry.provider as { id: string }).id))
    .map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  return [...compatProviders, ...activeOnlyProviders];
}
