import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";
import type { PluginManifestModelCatalog } from "../../plugins/manifest.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";

type ProviderAliasSource = {
  cfg: OpenClawConfig;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

function collectModelCatalogAliases(
  aliases: Map<string, string>,
  modelCatalog: PluginManifestModelCatalog | undefined,
): void {
  for (const [aliasProvider, target] of Object.entries(modelCatalog?.aliases ?? {})) {
    const alias = normalizeProviderId(aliasProvider);
    const provider = normalizeProviderId(target.provider);
    if (alias && provider) {
      aliases.set(alias, provider);
    }
  }
}

function buildProviderAliasMap(params: ProviderAliasSource): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const plugins =
    params.metadataSnapshot?.manifestRegistry.plugins ??
    loadPluginManifestRegistryCore({ config: params.cfg }).plugins;
  for (const plugin of plugins) {
    collectModelCatalogAliases(aliases, plugin.modelCatalog);
  }
  return aliases;
}

export function createModelCatalogProviderAliasCanonicalizer(params: ProviderAliasSource): {
  provider: (provider: string) => string;
  ref: <TRef extends { provider: string }>(ref: TRef) => TRef;
} {
  const aliases = buildProviderAliasMap(params);
  const provider = (providerId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
  return {
    provider,
    ref: (ref) => {
      const canonicalProvider = provider(ref.provider);
      return canonicalProvider === ref.provider ? ref : { ...ref, provider: canonicalProvider };
    },
  };
}
