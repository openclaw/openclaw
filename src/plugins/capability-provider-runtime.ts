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

  // Only run the capability-specific plugin discovery when cfg is provided AND
  // there might be additional capability-only plugins not yet in the active
  // registry. When the active registry already has providers for this key we
  // check whether the manifest registry declares more bundled capability
  // plugins than the active set covers — if so, some speech-only (or similar)
  // plugins were skipped and we need the loader pass. Otherwise return the
  // active providers directly to avoid the per-call snapshot/module-load cost
  // that the unconditional loader path caused (P1 regression).
  if (activeProviders.length > 0 && params.cfg !== undefined) {
    const bundledIds = resolveBundledCapabilityCompatPluginIds({
      key: params.key,
      cfg: params.cfg,
    });
    const activeIds = new Set(activeProviders.map((entry) => entry.provider?.id).filter(Boolean));
    const allCovered = bundledIds.every((id) => activeIds.has(id));
    if (allCovered) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
  }

  if (activeProviders.length > 0 && params.cfg === undefined) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }

  // cfg is available and the active registry is either empty or missing some
  // capability plugins — run the capability-specific loader. cache: false
  // prevents the loaded registry from replacing the active registry.
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
