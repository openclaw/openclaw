import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeEmptyPluginMetadataOwners } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

function ownerEntries(value: ReadonlyMap<string, readonly string[]>) {
  return [...value].map(([id, owners]) => [id, [...owners]] as const);
}

/** Verifies the manifest-derived fields of a trimmed metadata fixture agree. */
export function assertPluginMetadataSnapshotConsistency(snapshot: PluginMetadataSnapshot): void {
  const plugins = snapshot.manifestRegistry.plugins;
  const pluginIds = plugins.map((plugin) => plugin.id);
  if (JSON.stringify(snapshot.plugins.map((plugin) => plugin.id)) !== JSON.stringify(pluginIds)) {
    throw new Error("plugin metadata fixture registry and plugin list diverged");
  }
  if (snapshot.metrics.manifestPluginCount !== plugins.length) {
    throw new Error("plugin metadata fixture manifest count diverged");
  }
  if (snapshot.metrics.indexPluginCount !== snapshot.index.plugins.length) {
    throw new Error("plugin metadata fixture index count diverged");
  }

  const expectedProviderOwners = new Map<string, string[]>();
  const expectedCliBackendOwners = new Map<string, string[]>();
  const appendOwner = (owners: Map<string, string[]>, id: string, pluginId: string) => {
    const existing = owners.get(id) ?? [];
    if (!existing.includes(pluginId)) {
      owners.set(id, [...existing, pluginId]);
    }
  };

  for (const plugin of plugins) {
    if (snapshot.byPluginId.get(plugin.id) !== plugin) {
      throw new Error(`plugin metadata fixture lookup diverged for ${plugin.id}`);
    }
    const providers = new Set(plugin.providers);
    const cliBackends = new Set([...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])]);
    const authRefs = new Set([
      ...(plugin.providerAuthChoices ?? []).map((choice) => choice.choiceId),
      ...(plugin.providerAuthChoices ?? []).flatMap((choice) => choice.deprecatedChoiceIds ?? []),
    ]);

    for (const provider of providers) {
      appendOwner(expectedProviderOwners, provider, plugin.id);
    }
    for (const [alias, provider] of Object.entries(plugin.providerAuthAliases ?? {})) {
      if (typeof provider !== "string") {
        continue;
      }
      if (!providers.has(alias) || !providers.has(provider)) {
        throw new Error(`plugin metadata fixture alias ${alias} is outside ${plugin.id} providers`);
      }
      appendOwner(expectedProviderOwners, alias, plugin.id);
    }
    for (const choice of plugin.providerAuthChoices ?? []) {
      if (!providers.has(choice.provider)) {
        throw new Error(
          `plugin metadata fixture auth choice ${choice.choiceId} has an unknown provider`,
        );
      }
    }
    for (const backend of cliBackends) {
      appendOwner(expectedCliBackendOwners, normalizeProviderId(backend), plugin.id);
    }
    for (const ref of plugin.syntheticAuthRefs ?? []) {
      if (!providers.has(ref) && !cliBackends.has(ref) && !authRefs.has(ref)) {
        throw new Error(`plugin metadata fixture synthetic auth ref ${ref} has no owner`);
      }
    }
  }

  if (
    JSON.stringify(ownerEntries(snapshot.owners.providers)) !==
    JSON.stringify(ownerEntries(expectedProviderOwners))
  ) {
    throw new Error("plugin metadata fixture provider owners diverged");
  }
  if (
    JSON.stringify(ownerEntries(snapshot.owners.cliBackends)) !==
    JSON.stringify(ownerEntries(expectedCliBackendOwners))
  ) {
    throw new Error("plugin metadata fixture CLI backend owners diverged");
  }
}

export function createGatewayPluginMetadataSnapshot(
  config: OpenClawConfig,
): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    // Matches the real isolated bundled snapshot: no installed-index rows,
    // with the selected bundled manifests supplied below.
    plugins: [],
    diagnostics: [],
  };
  const emptySnapshot: PluginMetadataSnapshot = {
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: new Map(),
    owners: makeEmptyPluginMetadataOwners(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
  return rebasePluginMetadataSnapshotManifestRegistry(emptySnapshot, {
    plugins: [
      {
        id: "openai",
        channels: [],
        providers: ["openai"],
        cliBackends: [],
        syntheticAuthRefs: [],
        providerAuthChoices: [
          { provider: "openai", method: "oauth", choiceId: "openai" },
          {
            provider: "openai",
            method: "device-code",
            choiceId: "openai-device-code",
          },
          { provider: "openai", method: "api-key", choiceId: "openai-api-key" },
        ],
        modelSupport: { modelPrefixes: ["gpt-", "o1", "o3", "o4"] },
        skills: [],
        hooks: [],
        origin: "bundled",
        rootDir: "/test/openai",
        source: "/test/openai/index.ts",
        manifestPath: "/test/openai/openclaw.plugin.json",
      },
    ],
    diagnostics: [],
  });
}
