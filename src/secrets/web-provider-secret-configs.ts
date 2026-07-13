import type { PluginManifestContracts } from "../plugins/manifest.js";

export const WEB_PROVIDER_SECRET_CONFIGS = [
  { contract: "webSearchProviders", configPath: "webSearch.apiKey" },
  { contract: "webFetchProviders", configPath: "webFetch.apiKey" },
] as const;

export type WebProviderSecretConfig = (typeof WEB_PROVIDER_SECRET_CONFIGS)[number];

/** Lists exact provider-owned config paths without loading provider runtime. */
export function listWebProviderSecretConfigPaths(params: {
  contracts: PluginManifestContracts | undefined;
  contract: WebProviderSecretConfig["contract"];
}): string[] {
  if ((params.contracts?.[params.contract]?.length ?? 0) === 0) {
    return [];
  }
  return WEB_PROVIDER_SECRET_CONFIGS.filter((config) => config.contract === params.contract).map(
    (config) => config.configPath,
  );
}
