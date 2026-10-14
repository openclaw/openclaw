import { isDeepStrictEqual } from "node:util";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPluginRecordActive, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

/** Tools borrow the Gateway instance whose services prepared their runtime. */
export function adoptRuntimeToolRegistrations(
  target: PluginRegistry,
  runtime: PluginRegistry,
  config: OpenClawConfig,
): PluginRegistry {
  const preparedConfig = getPluginRuntimeLoadContext(runtime)?.activationSourceConfig;
  if (!preparedConfig || isPluginRegistryRetired(target) || isPluginRegistryRetired(runtime)) {
    return target;
  }
  const sourceConfig = projectConfigOntoRuntimeSourceSnapshot(config);
  const replacements = new Map<PluginToolRegistration, PluginToolRegistration>();
  for (const pluginId of new Set(target.tools.map((entry) => entry.pluginId))) {
    const localRecord = target.plugins.find((record) => record.id === pluginId);
    const runtimeRecord = runtime.plugins.find((record) => record.id === pluginId);
    if (
      localRecord?.status !== "loaded" ||
      !localRecord.enabled ||
      !runtimeRecord ||
      localRecord.source !== runtimeRecord.source ||
      !isPluginRecordActive(runtime, runtimeRecord) ||
      !isDeepStrictEqual(
        sourceConfig.plugins?.entries?.[pluginId]?.config,
        preparedConfig.plugins?.entries?.[pluginId]?.config,
      )
    ) {
      continue;
    }
    const owned = groupByDeclaredIdentity(runtime.tools, pluginId);
    // Repeated identities can be null-returning fallbacks: pair them one-to-one
    // in registration order, or leave an ambiguous group on discovery.
    for (const [identity, locals] of groupByDeclaredIdentity(target.tools, pluginId)) {
      const donors = owned.get(identity);
      if (donors?.length !== locals.length) {
        continue;
      }
      locals.forEach((local, index) => {
        const donor = donors[index];
        if (donor && donor !== local) {
          replacements.set(local, donor);
        }
      });
    }
  }
  return replacements.size === 0
    ? target
    : { ...target, tools: target.tools.map((entry) => replacements.get(entry) ?? entry) };
}

/** Unnamed registrations have no comparable identity and stay with discovery. */
function groupByDeclaredIdentity(
  tools: readonly PluginToolRegistration[],
  pluginId: string,
): Map<string, PluginToolRegistration[]> {
  const groups = new Map<string, PluginToolRegistration[]>();
  for (const entry of tools) {
    const names = [...new Set(entry.names)].toSorted();
    if (entry.pluginId !== pluginId || names.length === 0) {
      continue;
    }
    const identity = JSON.stringify([entry.optional, names]);
    groups.set(identity, [...(groups.get(identity) ?? []), entry]);
  }
  return groups;
}
