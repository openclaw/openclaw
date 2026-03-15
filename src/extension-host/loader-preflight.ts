import type { OpenClawConfig } from "../config/config.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginLogger } from "../plugins/types.js";
import { activateExtensionHostRegistry } from "./activation.js";
import {
  buildExtensionHostRegistryCacheKey,
  getCachedExtensionHostRegistry,
} from "./loader-cache.js";

export type ExtensionHostPluginLoadMode = "full" | "validate";

export type ExtensionHostLoaderPreflightOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  cache?: boolean;
  mode?: ExtensionHostPluginLoadMode;
};

export function prepareExtensionHostLoaderPreflight(params: {
  options: ExtensionHostLoaderPreflightOptions;
  createDefaultLogger: () => PluginLogger;
  clearPluginCommands: () => void;
  applyTestDefaults?: typeof applyTestPluginDefaults;
  normalizeConfig?: typeof normalizePluginsConfig;
  buildCacheKey?: typeof buildExtensionHostRegistryCacheKey;
  getCachedRegistry?: typeof getCachedExtensionHostRegistry;
  activateRegistry?: typeof activateExtensionHostRegistry;
}) {
  const applyTestDefaults = params.applyTestDefaults ?? applyTestPluginDefaults;
  const normalizeConfig = params.normalizeConfig ?? normalizePluginsConfig;
  const buildCacheKey = params.buildCacheKey ?? buildExtensionHostRegistryCacheKey;
  const getCachedRegistry = params.getCachedRegistry ?? getCachedExtensionHostRegistry;
  const activateRegistry = params.activateRegistry ?? activateExtensionHostRegistry;

  const env = params.options.env ?? process.env;
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const config = applyTestDefaults(params.options.config ?? {}, env);
  const logger = params.options.logger ?? params.createDefaultLogger();
  const validateOnly = params.options.mode === "validate";
  const normalizedConfig = normalizeConfig(config.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: params.options.workspaceDir,
    plugins: normalizedConfig,
    installs: config.plugins?.installs,
    env,
  });
  const cacheEnabled = params.options.cache !== false;

  if (cacheEnabled) {
    const cachedRegistry = getCachedRegistry(cacheKey);
    if (cachedRegistry) {
      activateRegistry(cachedRegistry, cacheKey);
      return {
        cacheHit: true as const,
        registry: cachedRegistry,
      };
    }
  }

  // Clear previously registered plugin commands before reloading.
  params.clearPluginCommands();

  return {
    cacheHit: false as const,
    env,
    config,
    logger,
    validateOnly,
    normalizedConfig,
    cacheKey,
  };
}
