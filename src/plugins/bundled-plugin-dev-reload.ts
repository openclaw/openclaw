import { isStandaloneRuntimeExecutable } from "../../cli-invocation.mjs";
import { isTruthyEnvValue } from "../infra/env.js";

/** Operator opt-in for development reload of edited bundled plugin code. */
export const BUNDLED_PLUGIN_DEV_RELOAD_ENV = "OPENCLAW_DEV_RELOAD_BUNDLED_PLUGINS";

export type BundledPluginDevReloadMode = { enabled: boolean; ignoredWarning?: string };

/**
 * Decide whether explicit bundled reload may recapture plugin code from disk.
 * Standalone executables own their bundled code, so they ignore the opt-in.
 */
export function resolveBundledPluginDevReloadMode(
  env: NodeJS.ProcessEnv = process.env,
): BundledPluginDevReloadMode {
  if (!isTruthyEnvValue(env[BUNDLED_PLUGIN_DEV_RELOAD_ENV])) {
    return { enabled: false };
  }
  if (isStandaloneRuntimeExecutable()) {
    return {
      enabled: false,
      ignoredWarning: `${BUNDLED_PLUGIN_DEV_RELOAD_ENV} is ignored: bundled plugin code is embedded in this executable. Install a new build and restart the Gateway.`,
    };
  }
  return { enabled: true };
}

/** Only explicit reload targets may recapture bundled code, and only after the operator opted in. */
export function resolveBundledCodeReloadPluginIds(
  request: { reason: string; pluginIds: readonly string[] } | undefined,
): readonly string[] | undefined {
  return request?.reason === "reload" && resolveBundledPluginDevReloadMode().enabled
    ? request.pluginIds
    : undefined;
}

/** Receipt warning for each bundled plugin whose code a development reload replaced. */
export function formatBundledPluginDevReloadWarning(pluginId: string): string {
  return `Development reload loaded ${pluginId} from disk; replaced code stays in memory until the Gateway restarts.`;
}
