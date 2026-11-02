import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

function normalizeStartupAgentHarnesses(record: PluginManifestRecord): readonly string[] {
  return [
    ...new Set([...(record.activation?.onAgentHarnesses ?? []), ...(record.cliBackends ?? [])]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function hasPluginKind(record: PluginManifestRecord, kind: string): boolean {
  return Array.isArray(record.kind)
    ? record.kind.some((entry) => entry === kind)
    : record.kind === kind;
}

function createInstalledPluginRecordFixture(
  record: PluginManifestRecord,
): InstalledPluginIndexRecord {
  const memory = hasPluginKind(record, "memory");
  return {
    pluginId: record.id,
    manifestPath: record.manifestPath,
    manifestHash: `test-${record.id}`,
    source: record.source,
    rootDir: record.rootDir,
    origin: record.origin,
    enabled: true,
    ...(record.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(record.packageManifest?.build ? { packageBuild: record.packageManifest.build } : {}),
    startup: {
      sidecar: record.activation?.onStartup === true,
      memory,
      agentHarnesses: normalizeStartupAgentHarnesses(record),
      configPaths: record.activation?.onConfigPaths ?? [],
    },
    contributions: {
      channels: record.channels,
      channelConfigs: Object.keys(record.channelConfigs ?? {}),
      providers: record.providers,
      modelCatalogProviders: [
        ...Object.keys(record.modelCatalog?.providers ?? {}),
        ...Object.keys(record.modelCatalog?.aliases ?? {}),
        ...(record.modelCatalog?.suppressions ?? []).map((entry) => entry.provider),
      ],
      modelSupportPrefixes: record.modelSupport?.modelPrefixes ?? [],
      modelSupportPatterns: record.modelSupport?.modelPatterns ?? [],
      autoEnableProviderIds: record.autoEnableWhenConfiguredProviders ?? [],
      commandAliases: record.commandAliases?.map((alias) => alias.name) ?? [],
      contracts: Object.fromEntries(Object.entries(record.contracts ?? {})),
    },
    compat: [],
  };
}

export function createInstalledPluginIndexFixture(
  registry: PluginManifestRegistry,
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: registry.plugins.map(createInstalledPluginRecordFixture),
    diagnostics: registry.diagnostics,
  };
}
