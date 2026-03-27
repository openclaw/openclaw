import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";

type CapabilityProviderRegistryKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
  useActiveRegistryWhen?: (active: PluginRegistry | undefined) => boolean;
}): CapabilityProviderForKey<K>[] {
  const active = getActivePluginRegistry();
  const shouldUseActive =
    params.useActiveRegistryWhen?.(active) ?? (active?.[params.key].length ?? 0) > 0;
  const registry =
    shouldUseActive || !params.cfg ? active : loadOpenClawPlugins({ config: params.cfg });
  return (registry?.[params.key] ?? []).map(
    (entry) => entry.provider,
  ) as CapabilityProviderForKey<K>[];
}
