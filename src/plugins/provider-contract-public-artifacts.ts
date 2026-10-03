import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { collectPublicArtifactFactories } from "./public-artifact-factories.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

function isProviderPlugin(value: unknown): value is ProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.auth)
  );
}

export function resolveBundledExplicitProviderContractsFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): ProviderContractEntry[] | null {
  const providers: ProviderContractEntry[] = [];
  for (const pluginId of sortUniqueStrings(params.onlyPluginIds)) {
    const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
      dirName: pluginId,
      artifactCandidates: ["provider-contract-api.js"],
    });
    if (!mod) {
      return null;
    }
    const entries = collectPublicArtifactFactories({
      mod,
      suffix: "Provider",
      isArtifact: isProviderPlugin,
    });
    if (entries.length === 0) {
      return null;
    }
    providers.push(...entries.map((provider) => ({ pluginId, provider })));
  }
  return providers;
}
