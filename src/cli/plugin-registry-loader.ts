import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import type { PluginRegistryScope } from "./plugin-registry.js";

let pluginRegistryModulePromise: Promise<typeof import("./plugin-registry.js")> | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("./plugin-registry.js");
  return pluginRegistryModulePromise;
}

export type CliPluginRegistryLoadPolicy = {
  scope: PluginRegistryScope;
  installBundledRuntimeDeps?: boolean;
};

export function resolvePluginRegistryLoadPolicyForCommandPath(
  commandPath: string[],
): CliPluginRegistryLoadPolicy {
  if (commandPath[0] === "status" || commandPath[0] === "health") {
    return {
      scope: "channels",
      installBundledRuntimeDeps: false,
    };
  }
  if (commandPath[0] === "channels") {
    return {
      scope: "configured-channels",
      installBundledRuntimeDeps: false,
    };
  }
  return { scope: "all" };
}

export async function ensureCliPluginRegistryLoaded(params: {
  scope: PluginRegistryScope;
  routeLogsToStderr?: boolean;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  installBundledRuntimeDeps?: boolean;
}) {
  const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
  const previousForceStderr = loggingState.forceConsoleToStderr;
  if (params.routeLogsToStderr) {
    loggingState.forceConsoleToStderr = true;
  }
  try {
    ensurePluginRegistryLoaded({
      scope: params.scope,
      ...(params.config ? { config: params.config } : {}),
      ...(params.activationSourceConfig
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.installBundledRuntimeDeps !== undefined
        ? { installBundledRuntimeDeps: params.installBundledRuntimeDeps }
        : {}),
    });
  } finally {
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
