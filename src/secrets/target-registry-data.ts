/** Builds the static and plugin-derived registry of secret migration targets. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";
import { loadChannelSecretContractApiForRecord } from "./channel-contract-api.js";
import { listOfficialExternalChannelSecretTargetRegistryEntries } from "./official-external-channel-secret-contract.js";
import { PROVIDER_REQUEST_SECRET_FIELD_GROUPS } from "./provider-request-secret-fields.js";
import { parseDotPath } from "./shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type PluginConfigTargetScope = {
  pluginIds: readonly string[];
  includeChannelContracts?: boolean;
};

const SECRET_INPUT_SHAPE = "secret_input"; // pragma: allowlist secret
const SIBLING_REF_SHAPE = "sibling_ref"; // pragma: allowlist secret

/** Static credential fields shared by auth-profile scanning and target discovery. */
export const AUTH_PROFILE_SECRET_FIELDS = {
  api_key: { authProfileType: "api_key", valueField: "key", refField: "keyRef" },
  token: { authProfileType: "token", valueField: "token", refField: "tokenRef" },
} as const;

const WEB_PROVIDER_SECRET_CONFIGS = [
  { contract: "webSearchProviders", configPath: "webSearch.apiKey" },
  { contract: "webFetchProviders", configPath: "webFetch.apiKey" },
] as const;

function createOpenClawConfigSecretTargetEntry(
  pathPattern: string,
  options: Partial<
    Pick<
      SecretTargetRegistryEntry,
      | "pathPatternSegments"
      | "targetType"
      | "targetTypeAliases"
      | "includeInConfigure"
      | "providerIdPathSegmentIndex"
      | "trackProviderShadowing"
    >
  > = {},
): SecretTargetRegistryEntry {
  return {
    id: pathPattern,
    targetType: pathPattern,
    configFile: "openclaw.json",
    pathPattern,
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    ...options,
  };
}

function createPluginOpenClawConfigSecretTargetEntry(
  pluginId: string,
  configPath: string,
): SecretTargetRegistryEntry {
  const pluginConfigPath = ["plugins", "entries", pluginId, "config"];
  const pathPatternSegments = [...pluginConfigPath, ...parseDotPath(configPath)];
  const pathPattern = `${formatConcreteConfigPath(pluginConfigPath)}.${configPath}`;
  return createOpenClawConfigSecretTargetEntry(pathPattern, { pathPatternSegments });
}

function listPluginWebProviderSecretTargetRegistryEntries(
  plugins: readonly PluginManifestRecord[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  for (const record of plugins) {
    for (const config of WEB_PROVIDER_SECRET_CONFIGS) {
      if (
        (record.contracts?.[config.contract]?.length ?? 0) > 0 &&
        record.configUiHints?.[config.configPath]?.sensitive === true
      ) {
        entries.push(createPluginOpenClawConfigSecretTargetEntry(record.id, config.configPath));
      }
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listPluginConfigSecretTargetRegistryEntries(
  plugins: readonly Pick<PluginManifestRecord, "id" | "configContracts">[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  for (const record of plugins) {
    const secretInputs = record.configContracts?.secretInputs?.paths ?? [];
    for (const secretInput of secretInputs) {
      const entry = createPluginOpenClawConfigSecretTargetEntry(record.id, secretInput.path);
      entries.push(entry);
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listChannelSecretTargetRegistryEntries(
  channelPlugins: readonly PluginManifestRecord[],
  throwOnLoadError = false,
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];

  for (const record of channelPlugins) {
    try {
      const contractApi = loadChannelSecretContractApiForRecord(record, { throwOnLoadError });
      entries.push(...(contractApi?.secretTargetRegistryEntries ?? []));
    } catch (error) {
      // Runtime can isolate unavailable owners; generated docs must never silently lose targets.
      if (throwOnLoadError) {
        throw error;
      }
    }
  }
  return entries;
}

const CORE_SECRET_TARGET_REGISTRY: SecretTargetRegistryEntry[] = [
  ...Object.values(AUTH_PROFILE_SECRET_FIELDS).map(
    ({ authProfileType, valueField, refField }): SecretTargetRegistryEntry => ({
      id: `auth-profiles.${authProfileType}.${valueField}`,
      targetType: `auth-profiles.${authProfileType}.${valueField}`,
      configFile: "auth-profile-store",
      pathPattern: `profiles.*.${valueField}`,
      refPathPattern: `profiles.*.${refField}`,
      secretShape: SIBLING_REF_SHAPE,
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
      authProfileType,
    }),
  ),
  ...[
    "tools.github.app.privateKey",
    "agents.entries.*.tools.github.app.privateKey",
    "memory.search.remote.apiKey",
    "agents.entries.*.memory.search.remote.apiKey",
    "cron.webhookToken",
    "database.postgres.connection",
    "gateway.auth.token",
    "gateway.auth.password",
    "gateway.remote.password",
    "gateway.remote.token",
  ].map((pathPattern) => createOpenClawConfigSecretTargetEntry(pathPattern)),
  // Header strings support authored env references, but not structured SecretRef config writes.
  ...["memory.search.remote.headers.*", "agents.entries.*.memory.search.remote.headers.*"].map(
    (pathPattern): SecretTargetRegistryEntry =>
      Object.assign(createOpenClawConfigSecretTargetEntry(pathPattern), {
        includeInPlan: false,
        includeInConfigure: false,
        includeInAudit: false,
      }),
  ),
  ...["tts", "agents.entries.*.tts"].flatMap((prefix) =>
    ["providers.*", "personas.*.providers.*"].map((providerPath): SecretTargetRegistryEntry => {
      const path = `${prefix}.${providerPath}.apiKey`;
      return createOpenClawConfigSecretTargetEntry(path, {
        includeInConfigure: prefix === "tts",
        providerIdPathSegmentIndex: path.split(".").length - 2,
      });
    }),
  ),
  ...[
    "apiKey",
    "headers.*",
    ...PROVIDER_REQUEST_SECRET_FIELD_GROUPS.toSorted(
      (left, right) => left.registryOrder - right.registryOrder,
    ).flatMap(({ path, fields }) =>
      (fields === "*" ? ["*"] : fields).map((field) => ["request", ...path, field].join(".")),
    ),
  ].map((suffix): SecretTargetRegistryEntry => {
    const pathPattern = `models.providers.*.${suffix}`;
    return createOpenClawConfigSecretTargetEntry(pathPattern, {
      targetType: pathPattern
        .split(".")
        .filter((segment) => segment !== "*")
        .join("."),
      targetTypeAliases: [pathPattern],
      providerIdPathSegmentIndex: 2,
      ...(suffix === "apiKey" ? { trackProviderShadowing: true } : {}),
    });
  }),
  createOpenClawConfigSecretTargetEntry("skills.entries.*.apiKey", {
    targetType: "skills.entries.apiKey",
    targetTypeAliases: ["skills.entries.*.apiKey"],
  }),
  createOpenClawConfigSecretTargetEntry("talk.providers.*.apiKey", {
    providerIdPathSegmentIndex: 2,
  }),
  createOpenClawConfigSecretTargetEntry("talk.realtime.providers.*.apiKey", {
    providerIdPathSegmentIndex: 3,
  }),
];

let cachedSecretTargetRegistry: SecretTargetRegistryEntry[] | null = null;

function loadSecretTargetRegistryFromPluginMetadata(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginConfig?: PluginConfigTargetScope;
  configuredOnly?: boolean;
}): SecretTargetRegistryEntry[] {
  const plugins = resolvePluginMetadataSnapshot({
    ...(params.config !== undefined ? { config: params.config } : {}),
    env: params.env,
    allowWorkspaceScopedCurrent: true,
    ...(params.pluginConfig?.pluginIds ? { pluginIds: params.pluginConfig.pluginIds } : {}),
  }).plugins;
  return buildSecretTargetRegistryFromPlugins(plugins, {
    pluginConfig: params.pluginConfig,
    ...(params.configuredOnly ? { config: params.config ?? {} } : {}),
  });
}

/** Builds secret targets from one exact manifest-registry plugin set. */
export function buildSecretTargetRegistryFromPlugins(
  plugins: readonly PluginManifestRecord[],
  options?: {
    throwOnLoadError?: boolean;
    /** Selected owners' manifest targets, optionally including their channel contracts. */
    pluginConfig?: PluginConfigTargetScope;
    /** Restrict discovery to subtrees present in this config, including disabled owners. */
    config?: OpenClawConfig;
  },
): SecretTargetRegistryEntry[] {
  const pluginConfigIds = options?.pluginConfig?.pluginIds
    ? new Set(options.pluginConfig.pluginIds)
    : options?.config
      ? new Set(Object.keys(options.config.plugins?.entries ?? {}))
      : null;
  const configPlugins = pluginConfigIds
    ? plugins.filter((record) => pluginConfigIds.has(record.id))
    : plugins;
  const channelIds = options?.config ? new Set(Object.keys(options.config.channels ?? {})) : null;
  const channelPlugins = (
    options?.pluginConfig
      ? options.pluginConfig.includeChannelContracts
        ? configPlugins
        : []
      : plugins
  ).filter(
    (record) =>
      (!channelIds ||
        // Shipped channel contracts may also declare their own plugin config secrets.
        pluginConfigIds?.has(record.id) ||
        (channelIds.size > 0 &&
          // External contracts can have multiple owners and cover more than one channel.
          // Only bundled contracts have a complete, channel-local artifact lookup.
          (record.origin !== "bundled" ||
            record.channels.some((id) => channelIds.has(id)) ||
            Object.keys(record.channelConfigs ?? {}).some((id) => channelIds.has(id)) ||
            channelIds.has(record.channelCatalogMeta?.id ?? "") ||
            channelIds.has(record.packageChannel?.id ?? "")))) &&
      (record.channels.length > 0 ||
        Object.keys(record.channelConfigs ?? {}).length > 0 ||
        Boolean(record.channelCatalogMeta?.id) ||
        Boolean(record.packageChannel?.id)),
  );
  // Installed/workspace plugins own secret targets exactly like bundled ones
  // (#104320: the Exa split moved web providers out of bundled origin and their
  // targets vanished from the gateway's known-target registry). Entries stay
  // manifest-scoped — web-provider contract + sensitive hint, or declared
  // secretInput paths — so a non-bundled origin cannot widen target paths
  // beyond its own declared contracts.
  const entries = [
    ...(options?.pluginConfig ? [] : CORE_SECRET_TARGET_REGISTRY),
    ...listPluginWebProviderSecretTargetRegistryEntries(configPlugins),
    ...listPluginConfigSecretTargetRegistryEntries(configPlugins),
    ...listChannelSecretTargetRegistryEntries(channelPlugins, options?.throwOnLoadError),
    // Catalog fallbacks are constructed under channels, never plugin config.
    ...(options?.pluginConfig || channelIds?.size === 0
      ? []
      : listOfficialExternalChannelSecretTargetRegistryEntries()),
  ];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.configFile}:${entry.pathPattern}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Returns static core secret target registry entries without plugin-derived targets. */
export function getCoreSecretTargetRegistry(): SecretTargetRegistryEntry[] {
  return CORE_SECRET_TARGET_REGISTRY;
}

/** Returns the full registry, configured subtrees, or selected plugin owners' targets. */
export function getSecretTargetRegistry(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginConfig?: PluginConfigTargetScope;
  configuredOnly?: boolean;
}): SecretTargetRegistryEntry[] {
  if (params?.config || params?.pluginConfig) {
    // Config-scoped plugin roots and policy are not process-stable. Compile these registries per
    // request so one config cannot poison discovery for a later config in the same process.
    return loadSecretTargetRegistryFromPluginMetadata({
      config: params.config,
      env: params.env ?? process.env,
      pluginConfig: params.pluginConfig,
      configuredOnly: params.configuredOnly,
    });
  }
  cachedSecretTargetRegistry ??= loadSecretTargetRegistryFromPluginMetadata({
    env: process.env,
  });
  return cachedSecretTargetRegistry;
}
