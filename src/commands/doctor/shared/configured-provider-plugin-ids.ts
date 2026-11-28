import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
} from "../../../plugins/official-external-plugin-catalog.js";
import {
  resolveWebSearchInstallCatalogEntriesForEnv,
  resolveWebSearchInstallCatalogEntry,
} from "../../../plugins/web-search-install-catalog.js";
import {
  collectConfiguredMediaProviderSelectionIds,
  collectConfiguredModelProviderSelectionIds,
} from "./configured-provider-selection-ids.js";

function shouldSkipAmbiguousMoonshotEnvDiscovery(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    !env.KIMI_API_KEY?.trim() ||
    env.MOONSHOT_API_KEY?.trim() ||
    cfg.plugins?.entries?.kimi?.enabled === false ||
    cfg.plugins?.deny?.includes("kimi")
  ) {
    return false;
  }
  // Kimi Code and Moonshot share this legacy variable, but not their credentials.
  // Explicit selections are collected separately; only ambiguous discovery yields.
  return (
    cfg.plugins?.entries?.kimi !== undefined ||
    resolveOfficialExternalProviderPluginIds({
      providerIds: collectConfiguredModelProviderSelectionIds(cfg),
    }).includes("kimi")
  );
}

/** Lists official external provider plugins without loading installed plugin registries. */
export function collectConfiguredOfficialProviderPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const configuredProviderIds = collectConfiguredModelProviderSelectionIds(params.cfg);
  const configuredMediaProviderIds = collectConfiguredMediaProviderSelectionIds(params.cfg);
  const env = params.env ?? process.env;
  const skipMoonshot = shouldSkipAmbiguousMoonshotEnvDiscovery(params.cfg, env);
  const pluginIds = new Set([
    ...resolveOfficialExternalProviderPluginIds({ providerIds: configuredProviderIds }),
    ...resolveOfficialExternalProviderPluginIdsForEnv(env).filter(
      (pluginId) => pluginId !== "moonshot" || !skipMoonshot,
    ),
    ...resolveOfficialExternalProviderContractPluginIds({
      contract: "mediaUnderstandingProviders",
      providerIds: configuredMediaProviderIds,
    }),
    ...resolveOfficialExternalProviderContractPluginIds({
      contract: "speechProviders",
      providerIds: configuredProviderIds,
    }),
  ]);
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function collectConfiguredWebSearchPluginIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  mode: "backfill" | "selected",
): string[] {
  const search = cfg.tools?.web?.search;
  if (search?.enabled === false) {
    return [];
  }
  // Release backfill preserves raw selections and also discovers environment providers.
  const providerId =
    mode === "backfill"
      ? typeof search?.provider === "string"
        ? search.provider
        : undefined
      : normalizeOptionalLowercaseString(search?.provider);
  const entry =
    providerId !== undefined ? resolveWebSearchInstallCatalogEntry({ providerId }) : undefined;
  const skipMoonshot = shouldSkipAmbiguousMoonshotEnvDiscovery(cfg, env);
  return [
    ...(entry?.pluginId ? [entry.pluginId] : []),
    ...(mode === "backfill" || !providerId
      ? resolveWebSearchInstallCatalogEntriesForEnv(env)
          .filter((candidate) => candidate.pluginId !== "moonshot" || !skipMoonshot)
          .map((candidate) => candidate.pluginId)
      : []),
  ];
}

export function collectConfiguredWebFetchPluginIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const webFetch = cfg.tools?.web?.fetch;
  if (webFetch?.enabled === false) {
    return [];
  }
  const providerId = normalizeOptionalLowercaseString(webFetch?.provider);
  return [
    ...(providerId
      ? resolveOfficialExternalProviderContractPluginIds({
          contract: "webFetchProviders",
          providerIds: new Set([providerId]),
        })
      : []),
    ...resolveOfficialExternalWebProviderContractPluginIdsForEnv({
      env,
    }),
  ];
}
