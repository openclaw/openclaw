import path from "node:path";
import { makePluginMetadataIndex } from "../plugins/current-plugin-metadata.test-support.js";
import type { PluginCandidate } from "../plugins/discovery.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const tempDirs: string[] = [];

export function makeBundledChannelCandidate(params: {
  pluginId: string;
  channelId: string;
}): PluginCandidate {
  return {
    idHint: params.pluginId,
    source: `/fake/${params.pluginId}/index.js`,
    rootDir: `/fake/${params.pluginId}`,
    origin: "bundled",
    packageManifest: {
      plugin: { id: params.pluginId },
      channel: { id: params.channelId },
    },
  };
}

/** Clears auto-enable plugin caches and temp dirs between tests. */
export function resetPluginAutoEnableTestState(): void {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
}

export function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-auto-enable", tempDirs);
}

export function makeIsolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const rootDir = makeTempDir();
  return {
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    VITEST: "true",
    ...overrides,
  };
}

type RegistryPlugin = Pick<
  PluginManifestRecord,
  | "id"
  | "channels"
  | "activation"
  | "autoEnableWhenConfiguredProviders"
  | "modelSupport"
  | "contracts"
  | "configSchema"
  | "channelConfigs"
> &
  Partial<Pick<PluginManifestRecord, "providers" | "cliBackends" | "origin">>;

export function makeRegistry(plugins: RegistryPlugin[]): PluginManifestRegistry {
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      channels: plugin.channels,
      activation: plugin.activation,
      autoEnableWhenConfiguredProviders: plugin.autoEnableWhenConfiguredProviders,
      modelSupport: plugin.modelSupport,
      contracts: plugin.contracts,
      configSchema: plugin.configSchema,
      channelConfigs: plugin.channelConfigs,
      providers: plugin.providers ?? [],
      cliBackends: plugin.cliBackends ?? [],
      skills: [],
      hooks: [],
      origin: plugin.origin ?? "config",
      rootDir: `/fake/${plugin.id}`,
      source: `/fake/${plugin.id}/index.js`,
      manifestPath: `/fake/${plugin.id}/openclaw.plugin.json`,
    })),
    diagnostics: [],
  };
}

export function createPluginMetadataSnapshot({
  config,
  manifestRegistry,
  workspaceDir,
}: {
  config?: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const { plugins, diagnostics } = manifestRegistry;
  const empty = createEmptyPluginMetadataSnapshot();
  const index: PluginMetadataSnapshot["index"] = {
    ...makePluginMetadataIndex(),
    policyHash,
    plugins: [],
  };
  return {
    ...empty,
    policyHash,
    ...(workspaceDir ? { workspaceDir } : {}),
    index,
    registryIndex: index,
    manifestRegistry,
    plugins,
    diagnostics,
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    owners: {
      ...empty.owners,
      providerAuthContributions:
        buildPluginMetadataProviderFacts(plugins).providerAuthContributions,
    },
    metrics: {
      ...empty.metrics,
      manifestPluginCount: plugins.length,
    },
  };
}

export function makeApnChannelConfig() {
  return { channels: { apn: { someKey: "value" } } };
}
