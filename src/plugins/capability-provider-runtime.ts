import type { OpenClawConfig } from "../config/config.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry.js";

type CapabilityProviderRegistryKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders";

type CapabilityContractKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;

const CAPABILITY_CONTRACT_KEY: Record<CapabilityProviderRegistryKey, CapabilityContractKey> = {
  speechProviders: "speechProviders",
  mediaUnderstandingProviders: "mediaUnderstandingProviders",
  imageGenerationProviders: "imageGenerationProviders",
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
  // When a caller config is provided, always resolve via the compat-config path so
  // bundled capability providers (e.g. groq for audio, deepgram) are injected even
  // when the active gateway registry already contains *other* providers of the same
  // capability type. The previous early-return on `activeProviders.length > 0` caused
  // the compat loading to be skipped entirely in that case, so a user-configured
  // provider (e.g. `tools.media.audio.models: [{provider: groq}]`) was silently
  // missing from the registry and every transcription attempt failed with
  // "Media provider not available: groq". See #59875.
  const loadOptions =
    params.cfg === undefined
      ? undefined
      : {
          config: resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg }),
        };
  if (loadOptions) {
    const registry = resolveRuntimePluginRegistry(loadOptions);
    const providers = (registry?.[params.key] ?? []).map(
      (entry) => entry.provider,
    ) as CapabilityProviderForKey<K>[];
    if (providers.length > 0) {
      return providers;
    }
  }
  // Fallback: no cfg provided or compat load yielded nothing — use the active registry.
  const activeRegistry = resolveRuntimePluginRegistry();
  return (activeRegistry?.[params.key] ?? []).map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
}
