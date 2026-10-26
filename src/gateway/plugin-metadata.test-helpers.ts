import assert from "node:assert/strict";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

function ownerEntries(value: ReadonlyMap<string, readonly string[]>) {
  return [...value].map(([id, owners]) => [id, [...owners]] as const);
}

/** Verifies the manifest-derived fields of a trimmed metadata fixture agree. */
export function assertPluginMetadataSnapshotConsistency(snapshot: PluginMetadataSnapshot): void {
  const plugins = snapshot.manifestRegistry.plugins;
  const pluginIds = plugins.map((plugin) => plugin.id);
  assert.deepEqual(
    snapshot.plugins.map((plugin) => plugin.id),
    pluginIds,
    "fixture plugin IDs",
  );
  assert.equal(snapshot.metrics.manifestPluginCount, plugins.length, "fixture manifest count");
  assert.equal(
    snapshot.metrics.indexPluginCount,
    snapshot.index.plugins.length,
    "fixture index count",
  );

  const expectedProviderOwners = new Map<string, string[]>();
  const expectedCliBackendOwners = new Map<string, string[]>();
  const appendOwner = (owners: Map<string, string[]>, id: string, pluginId: string) => {
    const existing = owners.get(id) ?? [];
    if (!existing.includes(pluginId)) {
      owners.set(id, [...existing, pluginId]);
    }
  };

  for (const plugin of plugins) {
    assert.equal(snapshot.byPluginId.get(plugin.id), plugin, `fixture lookup: ${plugin.id}`);
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
      assert(providers.has(alias) && providers.has(provider), `fixture alias: ${alias}`);
      appendOwner(expectedProviderOwners, alias, plugin.id);
    }
    for (const choice of plugin.providerAuthChoices ?? []) {
      assert(providers.has(choice.provider), `fixture auth provider: ${choice.choiceId}`);
    }
    for (const backend of cliBackends) {
      appendOwner(expectedCliBackendOwners, normalizeProviderId(backend), plugin.id);
    }
    for (const ref of plugin.syntheticAuthRefs ?? []) {
      assert(
        providers.has(ref) || cliBackends.has(ref) || authRefs.has(ref),
        `fixture auth ref: ${ref}`,
      );
    }
  }

  assert.deepEqual(ownerEntries(snapshot.owners.providers), ownerEntries(expectedProviderOwners));
  assert.deepEqual(
    ownerEntries(snapshot.owners.cliBackends),
    ownerEntries(expectedCliBackendOwners),
  );
}

export function createGatewayPluginMetadataSnapshot(
  config: OpenClawConfig,
): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const emptySnapshot = createEmptyPluginMetadataSnapshot();
  emptySnapshot.policyHash = emptySnapshot.index.policyHash = policyHash;
  emptySnapshot.index.generatedAtMs = 0;
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
          { provider: "openai", method: "device-code", choiceId: "openai-device-code" },
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
