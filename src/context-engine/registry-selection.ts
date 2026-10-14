import type { OpenClawConfig } from "../config/types.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "../plugins/config-state.js";
import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { pluginIdFromContextEngineOwner } from "./registry-adoption.js";

/** Applies canonical plugin policy to a registered engine without changing its engine ID. */
export function resolveEffectiveContextEngineId(
  config: OpenClawConfig | undefined,
  entries: ReadonlyMap<string, ContextEngineRegistration>,
): string {
  const plugins = normalizePluginsConfig(config?.plugins);
  const engineId = plugins.slots.contextEngine;
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  if (!engineId || engineId === defaultEngineId) {
    return defaultEngineId;
  }
  const entry = entries.get(engineId);
  // An absent registration retains the existing equal-ID selection contract and failure path.
  const pluginId = (entry && pluginIdFromContextEngineOwner(entry.owner)) ?? engineId;
  return resolveSelectedContextEnginePluginIdFromConfig(plugins, normalizePluginId(pluginId))
    ? engineId
    : defaultEngineId;
}
