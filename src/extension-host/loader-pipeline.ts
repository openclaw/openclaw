import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { CreatePluginRuntimeOptions } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { activateExtensionHostRegistry } from "./activation.js";
import { setCachedExtensionHostRegistry } from "./loader-cache.js";
import { prepareExtensionHostLoaderExecution } from "./loader-execution.js";
import type { ExtensionHostLoaderPreflightReady } from "./loader-preflight.js";
import { runExtensionHostLoaderSession } from "./loader-run.js";

export function executeExtensionHostLoaderPipeline(params: {
  preflight: ExtensionHostLoaderPreflightReady;
  workspaceDir?: string;
  cache?: boolean;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  warningCache: Set<string>;
  createRuntime: (runtimeOptions?: CreatePluginRuntimeOptions) => PluginRuntime;
  prepareExecution?: typeof prepareExtensionHostLoaderExecution;
  runSession?: typeof runExtensionHostLoaderSession;
}): PluginRegistry {
  const prepareExecution = params.prepareExecution ?? prepareExtensionHostLoaderExecution;
  const runSession = params.runSession ?? runExtensionHostLoaderSession;

  const execution = prepareExecution({
    config: params.preflight.config,
    workspaceDir: params.workspaceDir,
    env: params.preflight.env,
    cache: params.cache,
    cacheKey: params.preflight.cacheKey,
    normalizedConfig: params.preflight.normalizedConfig,
    logger: params.preflight.logger,
    coreGatewayHandlers: params.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    runtimeOptions: params.runtimeOptions,
    warningCache: params.warningCache,
    setCachedRegistry: setCachedExtensionHostRegistry,
    activateRegistry: activateExtensionHostRegistry,
    createRuntime: params.createRuntime,
  });

  return runSession({
    session: execution.session,
    orderedCandidates: execution.orderedCandidates,
    manifestByRoot: execution.manifestByRoot,
    normalizedConfig: params.preflight.normalizedConfig,
    rootConfig: params.preflight.config,
    validateOnly: params.preflight.validateOnly,
    createApi: execution.createApi,
    loadModule: execution.loadModule,
  });
}
