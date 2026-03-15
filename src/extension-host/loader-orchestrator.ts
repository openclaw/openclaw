import type { OpenClawConfig } from "../config/config.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  buildExtensionHostRegistryCacheKey,
  clearExtensionHostRegistryCache,
  getCachedExtensionHostRegistry,
  setCachedExtensionHostRegistry,
} from "../extension-host/loader-cache.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginCommands } from "../plugins/commands.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginLogger } from "../plugins/types.js";
import { prepareExtensionHostLoaderExecution } from "./loader-execution.js";
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
  const env = options.env ?? process.env;
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildExtensionHostRegistryCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
    installs: cfg.plugins?.installs,
    env,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedExtensionHostRegistry(cacheKey);
    if (cached) {
      activateExtensionHostRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading.
  clearPluginCommands();

  const execution = prepareExtensionHostLoaderExecution({
    config: cfg,
    workspaceDir: options.workspaceDir,
    env,
    cache: options.cache,
    cacheKey,
    normalizedConfig: normalized,
    logger,
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
    normalizedConfig: normalized,
    rootConfig: cfg,
    validateOnly,
    createApi: execution.createApi,
    loadModule: execution.loadModule,
  });
}
