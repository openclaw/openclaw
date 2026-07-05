// Root-help config probe for plugin-sensitive help rendering.
<<<<<<< HEAD
=======
import type { OpenClawConfig } from "../config/types.openclaw.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { RootHelpRenderOptions } from "./program/root-help.js";

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hasListEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

<<<<<<< HEAD
=======
/** Detect config fields that can change which plugin help sections are rendered. */
export function hasPluginHelpAffectingConfig(config: OpenClawConfig | null | undefined): boolean {
  const plugins = config?.plugins;
  if (!plugins) {
    return false;
  }
  return (
    plugins.enabled === false ||
    hasListEntries(plugins.allow) ||
    hasListEntries(plugins.deny) ||
    hasListEntries(plugins.load?.paths) ||
    hasEntries(plugins.slots) ||
    hasEntries(plugins.entries) ||
    hasEntries(plugins.installs)
  );
}

/** Detect env vars that can change bundled plugin availability in root help. */
export function hasPluginHelpAffectingEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
/** Load render options only when config/env can affect plugin help output. */
export async function loadRootHelpRenderOptionsForConfigSensitivePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootHelpRenderOptions | null> {
  const configModule = await import("../config/config.js");
  const snapshot = await configModule.readConfigFileSnapshot({
    observe: false,
    skipPluginValidation: true,
  });
  if (!snapshot.valid) {
    return null;
  }
<<<<<<< HEAD
  const plugins = snapshot.sourceConfig.plugins;
  const configAffectsPluginHelp =
    plugins &&
    (plugins.enabled === false ||
      hasListEntries(plugins.allow) ||
      hasListEntries(plugins.deny) ||
      hasListEntries(plugins.load?.paths) ||
      hasEntries(plugins.slots) ||
      hasEntries(plugins.entries) ||
      hasEntries(plugins.installs));
  const envAffectsPluginHelp = Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
  if (!envAffectsPluginHelp && !configAffectsPluginHelp) {
=======
  if (!hasPluginHelpAffectingEnv(env) && !hasPluginHelpAffectingConfig(snapshot.sourceConfig)) {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return null;
  }
  return {
    config: snapshot.runtimeConfig,
    env,
  };
}
