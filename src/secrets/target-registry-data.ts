import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { loadChannelSecretContractApiForRecord } from "./channel-contract-api.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const SECRET_INPUT_SHAPE = "secret_input"; // pragma: allowlist secret
const SIBLING_REF_SHAPE = "sibling_ref"; // pragma: allowlist secret

const WEB_PROVIDER_SECRET_CONFIGS = [
  { contract: "webSearchProviders", configPath: "webSearch.apiKey" },
  { contract: "webFetchProviders", configPath: "webFetch.apiKey" },
] as const;

type WebProviderSecretConfig = (typeof WEB_PROVIDER_SECRET_CONFIGS)[number];

function createPluginOpenClawConfigSecretTargetEntry(
  pluginId: string,
  configPath: string,
): SecretTargetRegistryEntry {
  const pathPattern = ["plugins", "entries", pluginId, "config", ...configPath.split(".")].join(
    ".",
  );
  return {
    id: pathPattern,
    targetType: pathPattern,
    store: "openclaw.json",
    pathPattern,
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };
}

function hasSensitiveConfigHint(
  plugin: PluginManifestRecord,
  configPath: WebProviderSecretConfig["configPath"],
): boolean {
  return plugin.configUiHints?.[configPath]?.sensitive === true;
}

function hasWebProviderContract(
  plugin: PluginManifestRecord,
  contract: WebProviderSecretConfig["contract"],
): boolean {
  return (plugin.contracts?.[contract]?.length ?? 0) > 0;
}

function listBundledWebProviderSecretTargetRegistryEntries(
  bundledPlugins: readonly PluginManifestRecord[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  for (const record of bundledPlugins) {
    for (const config of WEB_PROVIDER_SECRET_CONFIGS) {
      if (
        hasWebProviderContract(record, config.contract) &&
        hasSensitiveConfigHint(record, config.configPath)
      ) {
        entries.push(createPluginOpenClawConfigSecretTargetEntry(record.id, config.configPath));
      }
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listBundledPluginConfigSecretTargetRegistryEntries(
  bundledPlugins: readonly PluginManifestRecord[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const record of bundledPlugins) {
    const secretInputs = record.configContracts?.secretInputs?.paths ?? [];
    for (const secretInput of secretInputs) {
      const entry = createPluginOpenClawConfigSecretTargetEntry(record.id, secretInput.path);
      const key = `${entry.store}:${entry.pathPattern}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function listChannelSecretTargetRegistryEntries(
  channelPlugins: readonly PluginManifestRecord[],
): SecretTargetRegistryEntry[] {
  const entries: SecretTargetRegistryEntry[] = [];

  for (const record of channelPlugins) {
    const channelIds = record.channels;
    if (channelIds.length === 0) {
      continue;
    }
    try {
      const contractApi = loadChannelSecretContractApiForRecord(record);
      entries.push(...(contractApi?.secretTargetRegistryEntries ?? []));
    } catch {
      // Ignore channels that do not expose a usable secret contract artifact.
    }
  }
  return entries;
}

const CORE_SECRET_TARGET_REGISTRY: SecretTargetRegistryEntry[] = [
  {
    id: "auth-profiles.api_key.key",
    targetType: "auth-profiles.api_key.key",
    store: "auth-profile-store",
    pathPattern: "profiles.*.key",
    refPathPattern: "profiles.*.keyRef",
    secretShape: SIBLING_REF_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    authProfileType: "api_key",
  },
  {
    id: "auth-profiles.token.token",
    targetType: "auth-profiles.token.token",
    store: "auth-profile-store",
    pathPattern: "profiles.*.token",
    refPathPattern: "profiles.*.tokenRef",
    secretShape: SIBLING_REF_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    authProfileType: "token",
  },
  {
    id: "agents.defaults.memorySearch.remote.apiKey",
    targetType: "agents.defaults.memorySearch.remote.apiKey",
    store: "openclaw.json",
    pathPattern: "agents.defaults.memorySearch.remote.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "agents.list[].memorySearch.remote.apiKey",
    targetType: "agents.list[].memorySearch.remote.apiKey",
    store: "openclaw.json",
    pathPattern: "agents.list[].memorySearch.remote.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "cron.webhookToken",
    targetType: "cron.webhookToken",
    store: "openclaw.json",
    pathPattern: "cron.webhookToken",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.auth.token",
    targetType: "gateway.auth.token",
    store: "openclaw.json",
    pathPattern: "gateway.auth.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.auth.password",
    targetType: "gateway.auth.password",
    store: "openclaw.json",
    pathPattern: "gateway.auth.password",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.remote.password",
    targetType: "gateway.remote.password",
    store: "openclaw.json",
    pathPattern: "gateway.remote.password",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "gateway.remote.token",
    targetType: "gateway.remote.token",
    store: "openclaw.json",
    pathPattern: "gateway.remote.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "messages.tts.providers.*.apiKey",
    targetType: "messages.tts.providers.*.apiKey",
    store: "openclaw.json",
    pathPattern: "messages.tts.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 3,
  },
  {
    id: "agents.list[].tts.providers.*.apiKey",
    targetType: "agents.list[].tts.providers.*.apiKey",
    store: "openclaw.json",
    pathPattern: "agents.list[].tts.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: false,
    includeInAudit: true,
    providerIdPathSegmentIndex: 4,
  },
  {
    id: "models.providers.*.apiKey",
    targetType: "models.providers.apiKey",
    targetTypeAliases: ["models.providers.*.apiKey"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
    trackProviderShadowing: true,
  },
  {
    id: "models.providers.*.headers.*",
    targetType: "models.providers.headers",
    targetTypeAliases: ["models.providers.*.headers.*"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.headers.*",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.headers.*",
    targetType: "models.providers.request.headers",
    targetTypeAliases: ["models.providers.*.request.headers.*"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.headers.*",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.auth.token",
    targetType: "models.providers.request.auth.token",
    targetTypeAliases: ["models.providers.*.request.auth.token"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.auth.token",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.auth.value",
    targetType: "models.providers.request.auth.value",
    targetTypeAliases: ["models.providers.*.request.auth.value"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.auth.value",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.ca",
    targetType: "models.providers.request.proxy.tls.ca",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.ca"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.ca",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.cert",
    targetType: "models.providers.request.proxy.tls.cert",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.cert"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.cert",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.key",
    targetType: "models.providers.request.proxy.tls.key",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.key"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.key",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.proxy.tls.passphrase",
    targetType: "models.providers.request.proxy.tls.passphrase",
    targetTypeAliases: ["models.providers.*.request.proxy.tls.passphrase"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.proxy.tls.passphrase",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.ca",
    targetType: "models.providers.request.tls.ca",
    targetTypeAliases: ["models.providers.*.request.tls.ca"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.ca",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.cert",
    targetType: "models.providers.request.tls.cert",
    targetTypeAliases: ["models.providers.*.request.tls.cert"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.cert",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.key",
    targetType: "models.providers.request.tls.key",
    targetTypeAliases: ["models.providers.*.request.tls.key"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.key",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "models.providers.*.request.tls.passphrase",
    targetType: "models.providers.request.tls.passphrase",
    targetTypeAliases: ["models.providers.*.request.tls.passphrase"],
    store: "openclaw.json",
    pathPattern: "models.providers.*.request.tls.passphrase",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "skills.entries.*.apiKey",
    targetType: "skills.entries.apiKey",
    targetTypeAliases: ["skills.entries.*.apiKey"],
    store: "openclaw.json",
    pathPattern: "skills.entries.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "talk.providers.*.apiKey",
    targetType: "talk.providers.*.apiKey",
    store: "openclaw.json",
    pathPattern: "talk.providers.*.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    providerIdPathSegmentIndex: 2,
  },
  {
    id: "tools.web.search.apiKey",
    targetType: "tools.web.search.apiKey",
    store: "openclaw.json",
    pathPattern: "tools.web.search.apiKey",
    secretShape: SECRET_INPUT_SHAPE,
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

let cachedSecretTargetRegistry: SecretTargetRegistryEntry[] | null = null;

function loadSecretTargetRegistryFromPluginMetadata(params: {
  env: NodeJS.ProcessEnv;
  preferPersisted?: boolean;
}): SecretTargetRegistryEntry[] {
  const plugins =
    (params.preferPersisted === false
      ? undefined
      : getCurrentPluginMetadataSnapshot({
          config: {},
          env: params.env,
        })
    )?.plugins ??
    loadPluginMetadataSnapshot({
      config: {},
      env: params.env,
      ...(params.preferPersisted !== undefined ? { preferPersisted: params.preferPersisted } : {}),
    }).plugins;
  const bundledPlugins = plugins.filter((record) => record.origin === "bundled");
  const channelPlugins = plugins.filter((record) => record.channels.length > 0);
  return [
    ...CORE_SECRET_TARGET_REGISTRY,
    ...listBundledWebProviderSecretTargetRegistryEntries(bundledPlugins),
    ...listBundledPluginConfigSecretTargetRegistryEntries(bundledPlugins),
    ...listChannelSecretTargetRegistryEntries(channelPlugins),
  ];
}

export function getCoreSecretTargetRegistry(): SecretTargetRegistryEntry[] {
  return CORE_SECRET_TARGET_REGISTRY;
}

export function getSecretTargetRegistry(): SecretTargetRegistryEntry[] {
  if (cachedSecretTargetRegistry) {
    return cachedSecretTargetRegistry;
  }
  cachedSecretTargetRegistry = loadSecretTargetRegistryFromPluginMetadata({
    env: process.env,
  });
  return cachedSecretTargetRegistry;
}

export function getSourceSecretTargetRegistry(): SecretTargetRegistryEntry[] {
  return loadSecretTargetRegistryFromPluginMetadata({
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "extensions",
    },
    preferPersisted: false,
  });
}
