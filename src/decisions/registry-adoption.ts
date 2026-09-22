import { isDeepStrictEqual } from "node:util";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPluginRecordActive, isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";

/** Prepared Gateway views borrow the exact provider owner, not another circuit or admission pool. */
export function adoptRuntimeDecisionProviders(
  target: PluginRegistry,
  runtime: PluginRegistry,
  config: OpenClawConfig,
): PluginRegistry {
  const preparedConfig = getPluginRuntimeLoadContext(runtime)?.activationSourceConfig;
  if (!preparedConfig || isPluginRegistryRetired(target) || isPluginRegistryRetired(runtime)) {
    return target;
  }
  let changed = false;
  const sourceConfig = projectConfigOntoRuntimeSourceSnapshot(config);
  const decisionProviders = target.decisionProviders.map((entry) => {
    const owner = runtime.decisionProviders.find(
      (candidate) =>
        candidate.pluginId === entry.pluginId &&
        candidate.host.provider.id === entry.host.provider.id,
    );
    const localRecord = target.plugins.find((record) => record.id === entry.pluginId);
    if (
      !owner ||
      owner === entry ||
      localRecord?.status !== "loaded" ||
      !localRecord.enabled ||
      localRecord.source !== owner.host.record.source ||
      !isPluginRecordActive(runtime, owner.host.record) ||
      !isDeepStrictEqual(
        sourceConfig.plugins?.entries?.[entry.pluginId]?.config,
        preparedConfig.plugins?.entries?.[entry.pluginId]?.config,
      )
    ) {
      return entry;
    }
    changed = true;
    return owner;
  });
  return changed ? { ...target, decisionProviders } : target;
}
