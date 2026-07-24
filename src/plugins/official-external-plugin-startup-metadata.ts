// Owns the compact official-external metadata needed by Gateway startup paths.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type {
  PluginManifestCatalog,
  PluginManifestChannelConfig,
  PluginManifestContracts,
} from "./manifest.js";
import {
  GENERATED_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA,
  type OfficialExternalPluginStartupMetadata,
} from "./official-external-plugin-startup-metadata.generated.js";

const CONTRACT_KEYS = [
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "embeddingProviders",
  "memoryEmbeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const satisfies readonly (keyof PluginManifestContracts)[];

const METADATA = GENERATED_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA;
const METADATA_BY_PACKAGE = new Map(METADATA.map((entry) => [entry.packageName, entry]));
const METADATA_BY_PLUGIN_ID = new Map(
  METADATA.map((entry) => [entry.pluginId.toLowerCase(), entry]),
);
const METADATA_BY_LOOKUP_ID = new Map<string, OfficialExternalPluginStartupMetadata>();
for (const entry of METADATA) {
  for (const lookupId of [
    entry.pluginId,
    ...(entry.providers ?? []).flatMap((provider) => [provider.id, ...(provider.aliases ?? [])]),
    ...(entry.channels ?? []).flatMap((channel) => [channel.id, ...(channel.aliases ?? [])]),
  ]) {
    METADATA_BY_LOOKUP_ID.set(lookupId.toLowerCase(), entry);
  }
}

function normalizeIds(values: Iterable<string>): Set<string> {
  return new Set(
    [...values]
      .map((value) => normalizeOptionalLowercaseString(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function envHasAny(env: NodeJS.ProcessEnv, names: readonly string[] | undefined): boolean {
  return names?.some((name) => Boolean(env[name]?.trim())) ?? false;
}

function findMetadataByLookupId(value: string): OfficialExternalPluginStartupMetadata | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized ? METADATA_BY_LOOKUP_ID.get(normalized) : undefined;
}

/** Returns whether an id is a canonical official-external plugin id. */
export function isOfficialExternalPluginId(pluginId: string): boolean {
  const normalized = normalizeOptionalLowercaseString(pluginId);
  return normalized ? METADATA_BY_PLUGIN_ID.has(normalized) : false;
}

/** Returns the preferred install command argument for a plugin, channel, or provider id. */
export function resolveOfficialExternalPluginInstallHint(pluginId: string): string | undefined {
  return findMetadataByLookupId(pluginId)?.install?.preferredSpec;
}

/** Returns package ownership facts used to preserve managed-install trust. */
export function resolveOfficialExternalPluginPackageOwnership(
  packageName: string | undefined,
): { pluginId: string; source: string; npmSpec?: string } | undefined {
  const normalized = packageName?.trim();
  if (!normalized) {
    return undefined;
  }
  const entry = METADATA_BY_PACKAGE.get(normalized);
  return entry
    ? {
        pluginId: entry.pluginId,
        source: entry.source,
        ...(entry.install?.npmSpec ? { npmSpec: entry.install.npmSpec } : {}),
      }
    : undefined;
}

function mergeContracts(
  manifestContracts: PluginManifestContracts | undefined,
  catalogContracts: Readonly<Record<string, readonly string[]>> | undefined,
): PluginManifestContracts | undefined {
  if (!catalogContracts) {
    return manifestContracts;
  }
  const contracts: PluginManifestContracts = {};
  for (const key of CONTRACT_KEYS) {
    const merged = uniqueStrings(
      [...(manifestContracts?.[key] ?? []), ...(catalogContracts[key] ?? [])]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
    if (merged.length > 0) {
      contracts[key] = merged;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function mergeCatalog(
  manifestCatalog: PluginManifestCatalog | undefined,
  officialCatalog: OfficialExternalPluginStartupMetadata["catalog"],
): PluginManifestCatalog | undefined {
  const featuredCandidate = manifestCatalog?.featured ?? officialCatalog?.featured;
  const orderCandidate = manifestCatalog?.order ?? officialCatalog?.order;
  const featured = typeof featuredCandidate === "boolean" ? featuredCandidate : undefined;
  const order =
    typeof orderCandidate === "number" && Number.isFinite(orderCandidate)
      ? orderCandidate
      : undefined;
  if (featured === undefined && order === undefined) {
    return undefined;
  }
  return {
    ...(featured !== undefined ? { featured } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function mergeChannelConfigs(params: {
  manifestChannelConfigs?: Record<string, PluginManifestChannelConfig>;
  catalogChannelConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}): Record<string, PluginManifestChannelConfig> | undefined {
  if (!params.catalogChannelConfigs) {
    return params.manifestChannelConfigs;
  }
  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.catalogChannelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value as PluginManifestChannelConfig;
    }
  }
  for (const [key, value] of Object.entries(params.manifestChannelConfigs ?? {})) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    const catalogValue = merged[key];
    merged[key] = catalogValue
      ? {
          ...catalogValue,
          ...value,
          schema: value.schema ?? catalogValue.schema,
          ...(catalogValue.uiHints || value.uiHints
            ? { uiHints: { ...catalogValue.uiHints, ...value.uiHints } }
            : {}),
          ...((value.runtime ?? catalogValue.runtime)
            ? { runtime: value.runtime ?? catalogValue.runtime }
            : {}),
          ...((value.label ?? catalogValue.label)
            ? { label: value.label ?? catalogValue.label }
            : {}),
          ...((value.description ?? catalogValue.description)
            ? { description: value.description ?? catalogValue.description }
            : {}),
          ...((value.preferOver ?? catalogValue.preferOver)
            ? { preferOver: value.preferOver ?? catalogValue.preferOver }
            : {}),
          ...((value.commands ?? catalogValue.commands)
            ? { commands: value.commands ?? catalogValue.commands }
            : {}),
        }
      : value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Restores catalog compatibility for lagging official-external package manifests. */
export function applyOfficialExternalPluginManifestCompatibility(params: {
  packageName: string | undefined;
  catalog: PluginManifestCatalog | undefined;
  contracts: PluginManifestContracts | undefined;
  channelConfigs: Record<string, PluginManifestChannelConfig> | undefined;
}): {
  catalog: PluginManifestCatalog | undefined;
  contracts: PluginManifestContracts | undefined;
  channelConfigs: Record<string, PluginManifestChannelConfig> | undefined;
} {
  const metadata = params.packageName ? METADATA_BY_PACKAGE.get(params.packageName) : undefined;
  if (!metadata) {
    return params;
  }
  return {
    catalog: mergeCatalog(params.catalog, metadata.catalog),
    contracts: mergeContracts(params.contracts, metadata.contracts),
    channelConfigs: mergeChannelConfigs({
      manifestChannelConfigs: params.channelConfigs,
      catalogChannelConfigs: metadata.channelConfigs,
    }),
  };
}

/** Lists endpoint classifications mirrored from official external provider manifests. */
export function listOfficialExternalProviderEndpoints() {
  return METADATA.flatMap((entry) => entry.providerEndpoints ?? []);
}

/** Lists web-search provider ids and their owning plugins for startup validation. */
export function listOfficialExternalWebSearchProviderOwners(): Array<{
  providerId: string;
  pluginId: string;
}> {
  return METADATA.flatMap((entry) =>
    (entry.webSearchProviders ?? []).map((provider) => ({
      providerId: provider.id,
      pluginId: entry.pluginId,
    })),
  );
}

/** Lists exact environment variables that can activate official external channels. */
export function listOfficialExternalChannelEnvVars(): Array<{
  channelId: string;
  envVars: readonly string[];
}> {
  return METADATA.flatMap((entry) =>
    (entry.channels ?? []).flatMap((channel) =>
      channel.envVars?.length ? [{ channelId: channel.id, envVars: channel.envVars }] : [],
    ),
  );
}

export function hasOfficialExternalProviderTarget(params: {
  providerIds: Iterable<string>;
  env: NodeJS.ProcessEnv;
}): boolean {
  const providerIds = normalizeIds(params.providerIds);
  return METADATA.some((entry) =>
    entry.providers?.some(
      (provider) =>
        envHasAny(params.env, provider.envVars) ||
        [provider.id, ...(provider.aliases ?? [])].some((providerId) =>
          providerIds.has(providerId),
        ),
    ),
  );
}

export function hasOfficialExternalContractTarget(params: {
  contract: string;
  providerIds: Iterable<string>;
}): boolean {
  const providerIds = normalizeIds(params.providerIds);
  if (providerIds.size === 0) {
    return false;
  }
  return METADATA.some((entry) =>
    entry.contracts?.[params.contract]?.some((providerId) => providerIds.has(providerId)),
  );
}

export function hasOfficialExternalWebContractEnvTarget(params: {
  contract: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return METADATA.some((entry) => {
    const contractIds = normalizeIds(entry.contracts?.[params.contract] ?? []);
    return entry.webSearchProviders?.some(
      (provider) => contractIds.has(provider.id) && envHasAny(params.env, provider.envVars),
    );
  });
}

export function hasOfficialExternalChannelTarget(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  const channels = isRecord(params.config.channels) ? params.config.channels : undefined;
  return METADATA.some((entry) =>
    entry.channels?.some((channel) => {
      const channelConfig = channels?.[channel.id];
      return (
        (isRecord(channelConfig) && channelConfig.enabled !== false) ||
        envHasAny(params.env, channel.envVars)
      );
    }),
  );
}

export function hasOfficialExternalWebSearchTarget(params: {
  providerId?: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const configuredId = normalizeOptionalLowercaseString(params.providerId);
  return METADATA.some((entry) =>
    entry.webSearchProviders?.some(
      (provider) =>
        (configuredId !== undefined && provider.id === configuredId) ||
        envHasAny(params.env, provider.envVars),
    ),
  );
}
