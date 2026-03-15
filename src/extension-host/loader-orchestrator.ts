import type { OpenClawConfig } from "../config/config.js";
import { clearExtensionHostRegistryCache } from "../extension-host/loader-cache.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginCommands } from "../plugins/commands.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginLogger } from "../plugins/types.js";
import { executeExtensionHostLoaderPipeline } from "./loader-pipeline.js";
import { prepareExtensionHostLoaderPreflight } from "./loader-preflight.js";

export type ExtensionHostPluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<
    string,
    import("../gateway/server-methods/types.js").GatewayRequestHandler
  >;
  runtimeOptions?: CreatePluginRuntimeOptions;
  cache?: boolean;
  mode?: "full" | "validate";
};

const openAllowlistWarningCache = new Set<string>();

const defaultLogger = () => createSubsystemLogger("plugins");

export function clearExtensionHostLoaderState(): void {
  clearExtensionHostRegistryCache();
  openAllowlistWarningCache.clear();
}

export function loadExtensionHostPluginRegistry(
  options: ExtensionHostPluginLoadOptions = {},
): PluginRegistry {
  const preflight = prepareExtensionHostLoaderPreflight({
    options,
    createDefaultLogger: defaultLogger,
    clearPluginCommands,
  });
  if (preflight.cacheHit) {
    return preflight.registry;
  }

  return executeExtensionHostLoaderPipeline({
    preflight,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    coreGatewayHandlers: options.coreGatewayHandlers,
    runtimeOptions: options.runtimeOptions,
    warningCache: openAllowlistWarningCache,
    createRuntime: createPluginRuntime,
  });
}
