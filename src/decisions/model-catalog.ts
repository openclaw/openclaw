import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAvailableManifestContractPlugins } from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestDecisionModel } from "../plugins/manifest-types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveConfiguredDecisionProvider } from "./configured-providers.js";

/** One metadata-only catalog serves the Decision picker and agent capability guidance. */
export function listDecisionModels({
  config,
  snapshot,
}: {
  config: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
}): Array<PluginManifestDecisionModel & { pluginId: string }> {
  if (config.plugins?.enabled === false) {
    return [];
  }
  const plugins = listAvailableManifestContractPlugins({
    snapshot,
    config,
    contract: "decisionProviders",
  });
  const models: Array<PluginManifestDecisionModel & { pluginId: string }> = [];
  const seen = new Set<string>();
  const add = (model: PluginManifestDecisionModel & { pluginId: string }) => {
    const key = `${model.provider}/${model.id}`;
    if (!seen.has(key)) {
      models.push(model);
      seen.add(key);
    }
  };
  for (const plugin of plugins) {
    for (const model of plugin.decisionModels ?? []) {
      if (!resolveConfiguredDecisionProvider(config, model.provider)) {
        add({ ...model, pluginId: plugin.id });
      }
    }
  }
  for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
    const adapterId = provider.decisionProvider;
    if (provider.type !== "decision" || !adapterId) {
      continue;
    }
    const plugin = plugins.find((candidate) =>
      candidate.contracts?.decisionProviders?.includes(adapterId),
    );
    if (!plugin) {
      continue;
    }
    for (const model of provider.models ?? []) {
      // Custom checkpoints have no declared capabilities unless their exact adapter model is known.
      const declared = plugin.decisionModels?.find(
        (entry) => entry.provider === adapterId && entry.id === model.id,
      );
      add({
        provider: normalizeProviderId(id),
        id: model.id,
        name: model.name,
        pluginId: plugin.id,
        ...(declared?.capabilities ? { capabilities: declared.capabilities } : {}),
      });
    }
  }
  return models;
}
