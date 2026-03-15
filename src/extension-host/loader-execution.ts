import type { OpenClawConfig } from "../config/config.js";
import type { NormalizedPluginsConfig } from "../plugins/config-state.js";
import { createPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import type { CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginLogger } from "../plugins/types.js";
import { bootstrapExtensionHostPluginLoad } from "./loader-bootstrap.js";
import { resolveExtensionHostDiscoveryPolicy } from "./loader-discovery-policy.js";
import { createExtensionHostModuleLoader } from "./loader-module-loader.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
} from "./loader-policy.js";
import { createExtensionHostLazyRuntime } from "./loader-runtime-proxy.js";
import {
  createExtensionHostLoaderSession,
  type ExtensionHostLoaderSession,
} from "./loader-session.js";

export function prepareExtensionHostLoaderExecution(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
  cacheKey: string;
  normalizedConfig: NormalizedPluginsConfig;
  logger: PluginLogger;
  coreGatewayHandlers?: Record<string, unknown>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  warningCache: Set<string>;
  setCachedRegistry: (cacheKey: string, registry: PluginRegistry) => void;
  activateRegistry: (registry: PluginRegistry, cacheKey: string) => void;
  createRuntime: (runtimeOptions?: CreatePluginRuntimeOptions) => PluginRuntime;
  createRegistry?: typeof createPluginRegistry;
  bootstrapLoad?: typeof bootstrapExtensionHostPluginLoad;
  createModuleLoader?: typeof createExtensionHostModuleLoader;
  createSession?: typeof createExtensionHostLoaderSession;
}) {
  const createRegistry = params.createRegistry ?? createPluginRegistry;
  const bootstrapLoad = params.bootstrapLoad ?? bootstrapExtensionHostPluginLoad;
  const createModuleLoader = params.createModuleLoader ?? createExtensionHostModuleLoader;
  const createSession = params.createSession ?? createExtensionHostLoaderSession;

  const runtime = createExtensionHostLazyRuntime({
    runtimeOptions: params.runtimeOptions,
    createRuntime: params.createRuntime,
  });
  const { registry, createApi } = createRegistry({
    logger: params.logger,
    runtime,
    coreGatewayHandlers: params.coreGatewayHandlers as never,
  });

  const bootstrap = bootstrapLoad({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    warningCacheKey: params.cacheKey,
    warningCache: params.warningCache,
    cache: params.cache,
    normalizedConfig: params.normalizedConfig,
    logger: params.logger,
    registry,
    pushDiagnostics: pushExtensionHostDiagnostics,
    resolveDiscoveryPolicy: resolveExtensionHostDiscoveryPolicy,
    buildProvenanceIndex: buildExtensionHostProvenanceIndex,
    compareDuplicateCandidateOrder: compareExtensionHostDuplicateCandidateOrder,
  });

  const loadModule = createModuleLoader();
  const session: ExtensionHostLoaderSession = createSession({
    registry,
    logger: params.logger,
    env: params.env,
    provenance: bootstrap.provenance,
    cacheEnabled: params.cache !== false,
    cacheKey: params.cacheKey,
    memorySlot: params.normalizedConfig.slots.memory,
    setCachedRegistry: params.setCachedRegistry,
    activateRegistry: params.activateRegistry,
  });

  return {
    registry,
    createApi,
    loadModule,
    session,
    orderedCandidates: bootstrap.orderedCandidates,
    manifestByRoot: bootstrap.manifestByRoot,
  };
}
