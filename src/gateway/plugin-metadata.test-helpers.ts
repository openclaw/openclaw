import assert from "node:assert/strict";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

function ownerEntries(value: ReadonlyMap<string, readonly string[]>) {
  return [...value].map(([id, owners]) => [id, [...owners]] as const);
}

/** Verifies the manifest-derived fields of a trimmed metadata fixture agree. */
export function assertPluginMetadataSnapshotConsistency(snapshot: PluginMetadataSnapshot): void {
  const plugins = snapshot.manifestRegistry.plugins;
  assert.deepEqual(
    snapshot.plugins.map((plugin) => plugin.id),
    plugins.map((plugin) => plugin.id),
  );
  assert.deepEqual(
    [snapshot.metrics.manifestPluginCount, snapshot.metrics.indexPluginCount],
    [plugins.length, snapshot.index.plugins.length],
    "fixture manifest/index counts",
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
