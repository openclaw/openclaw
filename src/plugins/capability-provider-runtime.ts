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
  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];

  // Always attempt capability loader when cfg is available so that speech-only
  // plugins like elevenlabs are discovered even when the main registry already
  // contains a different provider (e.g. openai registers both model + speech).
  // cache: false prevents the loaded registry from replacing the active registry
  // (activate:false requires cache:false per loadOpenClawPlugins contract).
  const loadOptions =
    params.cfg === undefined
      ? undefined
      : {
          config: resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg }),
          cache: false as const,
          activate: false as const,
        };
  const capabilityRegistry = loadOptions ? resolveRuntimePluginRegistry(loadOptions) : undefined;
  const capabilityProviders = capabilityRegistry?.[params.key] ?? [];

  // Merge: active providers first, then capability-only providers not already present.
  const seenIds = new Set(activeProviders.map((entry) => entry.provider?.id).filter(Boolean));
  const merged = [
    ...activeProviders,
    ...capabilityProviders.filter((entry) => !seenIds.has(entry.provider?.id)),
  ];

  return merged.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
}
