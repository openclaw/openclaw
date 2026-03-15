import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { PluginRecord } from "../../plugins/registry.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginHttpRouteParams,
  PluginInteractiveHandlerRegistration,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
  PluginLogger,
  PluginHookName,
  PluginHookHandlerMap,
  ProviderPlugin,
} from "../../plugins/types.js";
import { resolveUserPath } from "../../utils.js";

export function normalizeExtensionHostPluginLogger(logger: PluginLogger): PluginLogger {
  return {
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  };
}

export function createExtensionHostPluginApi(params: {
  record: PluginRecord;
  runtime: PluginRuntime;
  logger: PluginLogger;
  config: OpenClawPluginApi["config"];
  pluginConfig?: Record<string, unknown>;
  registerTool: (
    tool: OpenClawPluginToolFactory | AnyAgentTool,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
  registerHook: (
    events: string | string[],
    handler: Parameters<OpenClawPluginApi["registerHook"]>[1],
    opts?: Parameters<OpenClawPluginApi["registerHook"]>[2],
  ) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
  registerChannel: (registration: OpenClawPluginChannelRegistration | object) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerGatewayMethod: (
    method: string,
    handler: OpenClawPluginApi["registerGatewayMethod"] extends (m: string, h: infer H) => void
      ? H
      : never,
  ) => void;
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  registerContextEngine: (
    id: string,
    factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1],
  ) => void;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
}): OpenClawPluginApi {
  return {
    id: params.record.id,
    name: params.record.name,
    version: params.record.version,
    description: params.record.description,
    source: params.record.source,
    config: params.config,
    pluginConfig: params.pluginConfig,
    runtime: params.runtime,
    logger: normalizeExtensionHostPluginLogger(params.logger),
    registerTool: (tool, opts) => params.registerTool(tool as never, opts),
    registerHook: (events, handler, opts) => params.registerHook(events, handler, opts),
    registerHttpRoute: (routeParams) => params.registerHttpRoute(routeParams),
    registerChannel: (registration) => params.registerChannel(registration),
    registerProvider: (provider) => params.registerProvider(provider),
    registerGatewayMethod: (method, handler) => params.registerGatewayMethod(method, handler),
    registerInteractiveHandler: (registration) => params.registerInteractiveHandler(registration),
    registerCli: (registrar, opts) => params.registerCli(registrar, opts),
    registerService: (service) => params.registerService(service),
    registerCommand: (command) => params.registerCommand(command),
    registerContextEngine: (id, factory) => params.registerContextEngine(id, factory),
    resolvePath: (input) => resolveUserPath(input),
    on: (hookName, handler, opts) => params.on(hookName as never, handler as never, opts),
  };
}
