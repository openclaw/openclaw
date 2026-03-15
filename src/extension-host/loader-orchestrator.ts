import type { OpenClawConfig } from "../config/config.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  clearExtensionHostRegistryCache,
  setCachedExtensionHostRegistry,
} from "../extension-host/loader-cache.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginCommands } from "../plugins/commands.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginLogger } from "../plugins/types.js";
import { prepareExtensionHostLoaderExecution } from "./loader-execution.js";
import { prepareExtensionHostLoaderPreflight } from "./loader-preflight.js";
import { runExtensionHostLoaderSession } from "./loader-run.js";

export type ExtensionHostPluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
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

  const execution = prepareExtensionHostLoaderExecution({
    config: preflight.config,
    workspaceDir: options.workspaceDir,
    env: preflight.env,
    cache: options.cache,
    cacheKey: preflight.cacheKey,
    normalizedConfig: preflight.normalizedConfig,
    logger: preflight.logger,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    runtimeOptions: options.runtimeOptions,
    warningCache: openAllowlistWarningCache,
    setCachedRegistry: setCachedExtensionHostRegistry,
    activateRegistry: activateExtensionHostRegistry,
    createRuntime: createPluginRuntime,
  });

  return runExtensionHostLoaderSession({
    session: execution.session,
    orderedCandidates: execution.orderedCandidates,
    manifestByRoot: execution.manifestByRoot,
    normalizedConfig: preflight.normalizedConfig,
    rootConfig: preflight.config,
    validateOnly: preflight.validateOnly,
    createApi: execution.createApi,
    loadModule: execution.loadModule,
  });
}
