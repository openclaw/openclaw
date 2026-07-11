// Resolves official provider plugins implied by configured auth and model selections.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeNullableString as normalizeId } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
} from "../../../plugins/official-external-plugin-catalog.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { asObjectRecord } from "./object.js";

function collectConfiguredProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  for (const profile of Object.values(asObjectRecord(cfg.auth?.profiles) ?? {})) {
    add(asObjectRecord(profile)?.provider);
  }
  for (const providerId of Object.keys(asObjectRecord(cfg.models?.providers) ?? {})) {
    add(providerId);
  }
  const modelByChannel = asObjectRecord(cfg.channels?.modelByChannel);
  for (const [providerId, channelMap] of Object.entries(modelByChannel ?? {})) {
    add(providerId);
    for (const modelRef of Object.values(asObjectRecord(channelMap) ?? {})) {
      if (typeof modelRef !== "string") {
        continue;
      }
      const slash = modelRef.indexOf("/");
      if (slash > 0) {
        add(modelRef.slice(0, slash));
      }
    }
  }
  for (const { value } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
    const slash = value.indexOf("/");
    if (slash > 0) {
      add(value.slice(0, slash));
    }
  }
  return ids;
}

function collectConfiguredMediaProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  const addModels = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const model of value) {
      add(asObjectRecord(model)?.provider);
    }
  };
  const media = cfg.tools?.media;
  addModels(media?.models);
  addModels(media?.image?.models);
  addModels(media?.audio?.models);
  addModels(media?.video?.models);
  return ids;
}

/** Lists external provider plugins implied by configured auth profiles and model refs. */
export function collectConfiguredProviderPluginIds(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const configuredProviderIds = collectConfiguredProviderIds(params.cfg);
  const configuredMediaProviderIds = collectConfiguredMediaProviderIds(params.cfg);
  const selectedProviderIds = new Set([...configuredProviderIds, ...configuredMediaProviderIds]);
  const pluginIds = new Set(
    resolveOfficialExternalProviderPluginIds({
      providerIds: selectedProviderIds,
    }),
  );
  for (const pluginId of resolveOfficialExternalProviderPluginIdsForEnv(
    params.env ?? process.env,
  )) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "mediaUnderstandingProviders",
    providerIds: configuredMediaProviderIds,
  })) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of resolveOfficialExternalProviderContractPluginIds({
    contract: "speechProviders",
    providerIds: configuredProviderIds,
  })) {
    pluginIds.add(pluginId);
  }
  for (const entry of resolveProviderInstallCatalogEntries({
    config: params.cfg,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    if (
      [entry.providerId, ...(entry.providerAliases ?? [])].some((providerId) =>
        selectedProviderIds.has(providerId.toLowerCase()),
      )
    ) {
      pluginIds.add(entry.pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
