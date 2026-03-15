import type { OpenClawConfig } from "../config/config.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  buildExtensionHostRegistryCacheKey,
  clearExtensionHostRegistryCache,
  getCachedExtensionHostRegistry,
  setCachedExtensionHostRegistry,
} from "../extension-host/loader-cache.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
} from "../extension-host/loader-policy.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginCommands } from "../plugins/commands.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "../plugins/config-state.js";
import { createPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginLogger } from "../plugins/types.js";
import { bootstrapExtensionHostPluginLoad } from "./loader-bootstrap.js";
import { resolveExtensionHostDiscoveryPolicy } from "./loader-discovery-policy.js";
import { createExtensionHostModuleLoader } from "./loader-module-loader.js";
import { createExtensionHostLazyRuntime } from "./loader-runtime-proxy.js";
import {
  createExtensionHostLoaderSession,
  finalizeExtensionHostLoaderSession,
  processExtensionHostLoaderSessionCandidate,
} from "./loader-session.js";

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

  const runtime = createExtensionHostLazyRuntime({
    runtimeOptions: options.runtimeOptions,
    createRuntime: createPluginRuntime,
  });
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const bootstrap = bootstrapExtensionHostPluginLoad({
    config: cfg,
    workspaceDir: options.workspaceDir,
    env,
    warningCacheKey: cacheKey,
    warningCache: openAllowlistWarningCache,
    cache: options.cache,
    normalizedConfig: normalized,
    logger,
    registry,
    pushDiagnostics: pushExtensionHostDiagnostics,
    resolveDiscoveryPolicy: resolveExtensionHostDiscoveryPolicy,
    buildProvenanceIndex: buildExtensionHostProvenanceIndex,
    compareDuplicateCandidateOrder: compareExtensionHostDuplicateCandidateOrder,
  });

  const loadModule = createExtensionHostModuleLoader();

  const session = createExtensionHostLoaderSession({
    registry,
    logger,
    env,
    provenance: bootstrap.provenance,
    cacheEnabled,
    cacheKey,
    memorySlot: normalized.slots.memory,
    setCachedRegistry: setCachedExtensionHostRegistry,
    activateRegistry: activateExtensionHostRegistry,
  });

  for (const candidate of bootstrap.orderedCandidates) {
    const manifestRecord = bootstrap.manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    processExtensionHostLoaderSessionCandidate({
      session,
      candidate,
      manifestRecord,
      normalizedConfig: normalized,
      rootConfig: cfg,
      validateOnly,
      createApi,
      loadModule,
    });
  }

  return finalizeExtensionHostLoaderSession(session);
}
