import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";

const log = createSubsystemLogger("plugins");

export function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
): PluginLoadOptions["config"] {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: undefined,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env,
  });
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}) {
  return loadOpenClawPlugins({
    config: buildBundledCapabilityRuntimeConfig(params.pluginIds, params.env),
    env: params.env,
    onlyPluginIds: [...params.pluginIds],
    cache: false,
    activate: false,
    logger: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message),
    },
  });
}
