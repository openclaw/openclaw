import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

export type DeclaredProviderOwnerIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderOwnerManifest = {
  id: string;
  providers: readonly string[];
  setup?: { providers?: readonly { id: string }[] };
};

/** Captures declared receivers independently from plugins triggered by a provider. */
export function buildDeclaredProviderOwnerIndex(
  manifests: readonly ProviderOwnerManifest[],
): DeclaredProviderOwnerIndex {
  const winners = new Map<string, ProviderOwnerManifest>();
  for (const plugin of manifests) {
    if (!winners.has(plugin.id)) {
      winners.set(plugin.id, plugin);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const phase of ["runtime", "setup"] as const) {
    const runtimeRefs = new Set(owners.keys());
    for (const plugin of winners.values()) {
      const refs =
        phase === "runtime"
          ? plugin.providers
          : (plugin.setup?.providers?.map((entry) => entry.id) ?? []);
      for (const ref of refs) {
        const normalized = normalizeProviderId(ref);
        if (phase === "setup" && runtimeRefs.has(normalized)) {
          continue;
        }
        const ids = owners.get(normalized) ?? new Set<string>();
        ids.add(plugin.id);
        owners.set(normalized, ids);
      }
    }
  }
  return owners;
}

export function matchesDeclaredProviderOwner(
  owners: DeclaredProviderOwnerIndex | undefined,
  provider: string,
  pluginId: string,
): boolean {
  return owners?.get(normalizeProviderId(provider))?.has(pluginId) ?? true;
}

/** Runtime aliases require a provider declared by the same plugin. */
export function pluginOwnsProviderRef(
  plugin: PluginManifestRecord,
  normalizedProvider: string,
): boolean {
  if (plugin.providers.length === 0) {
    return false;
  }
  const providers = new Set(plugin.providers.map(normalizeProviderId));
  if (providers.has(normalizedProvider)) {
    return true;
  }
  const ownsAlias = (rawAlias: string, target: string) => {
    const targetProvider = normalizeProviderId(target);
    return (
      normalizeProviderId(rawAlias) === normalizedProvider &&
      Boolean(targetProvider) &&
      providers.has(targetProvider)
    );
  };
  return (
    Object.entries(plugin.providerAuthAliases ?? {}).some(
      ([alias, target]) => typeof target === "string" && ownsAlias(alias, target),
    ) ||
    Object.entries(plugin.modelCatalog?.aliases ?? {}).some(([alias, target]) =>
      ownsAlias(alias, target.provider),
    )
  );
}
