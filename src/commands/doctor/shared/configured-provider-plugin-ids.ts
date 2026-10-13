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

/** Lists official external provider plugins without loading installed plugin registries. */
export function collectConfiguredOfficialProviderPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const configuredProviderIds = collectConfiguredModelProviderSelectionIds(params.cfg);
  const configuredMediaProviderIds = collectConfiguredMediaProviderSelectionIds(params.cfg);
  const pluginIds = new Set([
    ...resolveOfficialExternalProviderPluginIds({ providerIds: configuredProviderIds }),
    ...resolveOfficialExternalProviderPluginIdsForEnv(params.env ?? process.env),
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
  return [
    ...(entry?.pluginId ? [entry.pluginId] : []),
    ...(mode === "backfill" || !providerId
      ? resolveWebSearchInstallCatalogEntriesForEnv(env).map((candidate) => candidate.pluginId)
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
      contract: "webFetchProviders",
      env,
    }),
  ];
}
