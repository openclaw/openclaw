import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { registerContextEngine } from "../context-engine/registry.js";
import {
  addExtensionChannelRegistration,
  addExtensionCliRegistration,
  addExtensionCommandRegistration,
  addExtensionGatewayMethodRegistration,
  addExtensionHttpRouteRegistration,
  addExtensionProviderRegistration,
  addExtensionServiceRegistration,
  addExtensionToolRegistration,
} from "../extension-host/registry-writes.js";
import {
  resolveExtensionChannelRegistration,
  resolveExtensionCliRegistration,
  resolveExtensionCommandRegistration,
  resolveExtensionContextEngineRegistration,
  resolveExtensionGatewayMethodRegistration,
  resolveExtensionLegacyHookRegistration,
  resolveExtensionHttpRouteRegistration,
  resolveExtensionProviderRegistration,
  resolveExtensionServiceRegistration,
  resolveExtensionToolRegistration,
  resolveExtensionTypedHookRegistration,
} from "../extension-host/runtime-registrations.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import { registerPluginCommand } from "./commands.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "./types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginHookOptions,
  ProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginLogger,
  PluginOrigin,
  PluginKind,
  PluginHookName,
  PluginHookHandlerMap,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";

export type PluginToolRegistration = {
  pluginId: string;
  factory: OpenClawPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
};

export type PluginCliRegistration = {
  pluginId: string;
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  source: string;
};

export type PluginHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  source?: string;
};

export type PluginChannelRegistration = {
  pluginId: string;
  plugin: ChannelPlugin;
  dock?: ChannelDock;
  source: string;
};

export type PluginProviderRegistration = {
  pluginId: string;
  provider: ProviderPlugin;
  source: string;
};

export type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
};

export type PluginServiceRegistration = {
  pluginId: string;
  service: OpenClawPluginService;
  source: string;
};

export type PluginCommandRegistration = {
  pluginId: string;
  command: OpenClawPluginCommandDefinition;
  source: string;
};

export type PluginRecordLifecycleState =
  | "prepared"
  | "imported"
  | "disabled"
  | "validated"
  | "registered"
  | "ready"
  | "error";

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  kind?: PluginKind;
  source: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  lifecycleState?: PluginRecordLifecycleState;
  error?: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: Record<string, unknown>;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  commands: PluginCommandRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  runtime: PluginRuntime;
};

type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
};

const constrainLegacyPromptInjectionHook = (
  handler: PluginHookHandlerMap["before_agent_start"],
): PluginHookHandlerMap["before_agent_start"] => {
  return (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };
};

export function createEmptyPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const result = resolveExtensionToolRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      tool,
      opts,
    });
    addExtensionToolRegistration({ registry, record, names: result.names, entry: result.entry });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
  ) => {
    const normalized = resolveExtensionLegacyHookRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      events,
      handler,
      opts,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }
    record.hookNames.push(normalized.hookName);
    registry.hooks.push({
      pluginId: normalized.entry.pluginId,
      entry: normalized.entry.entry,
      events: normalized.events,
      source: normalized.entry.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }

    for (const event of normalized.events) {
      registerInternalHook(event, handler);
    }
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
  ) => {
    const result = resolveExtensionGatewayMethodRegistration({
      existing: registry.gatewayHandlers,
      coreGatewayMethods,
      method,
      handler,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    addExtensionGatewayMethodRegistration({
      registry,
      record,
      method: result.method,
      handler: result.handler,
    });
  };

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const result = resolveExtensionHttpRouteRegistration({
      existing: registry.httpRoutes,
      ownerPluginId: record.id,
      ownerSource: record.source,
      route: params,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: result.message === "http route registration missing path" ? "warn" : "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    if (result.action === "replace") {
      addExtensionHttpRouteRegistration({
        registry,
        record,
        action: "replace",
        existingIndex: result.existingIndex,
        entry: result.entry,
      });
      return;
    }
    addExtensionHttpRouteRegistration({
      registry,
      record,
      action: "append",
      entry: result.entry,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
  ) => {
    const result = resolveExtensionChannelRegistration({
      existing: registry.channels,
      ownerPluginId: record.id,
      ownerSource: record.source,
      registration,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    addExtensionChannelRegistration({
      registry,
      record,
      channelId: result.channelId,
      entry: result.entry,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      source: record.source,
      provider,
      pushDiagnostic,
    });
    if (!normalizedProvider) {
      return;
    }
    const result = resolveExtensionProviderRegistration({
      existing: registry.providers,
      ownerPluginId: record.id,
      ownerSource: record.source,
      provider: normalizedProvider,
    });
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: result.message,
      });
      return;
    }
    addExtensionProviderRegistration({
      registry,
      record,
      providerId: result.providerId,
      entry: result.entry,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => {
    const result = resolveExtensionCliRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      registrar,
      opts,
    });
    addExtensionCliRegistration({
      registry,
      record,
      commands: result.commands,
      entry: result.entry,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const result = resolveExtensionServiceRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      service,
    });
    if (!result.ok) {
      return;
    }
    addExtensionServiceRegistration({
      registry,
      record,
      serviceId: result.serviceId,
      entry: result.entry,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const normalized = resolveExtensionCommandRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      command,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }

    // Register with the plugin command system (validates name and checks for duplicates)
    const result = registerPluginCommand(record.id, normalized.entry.command);
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: ${result.error}`,
      });
      return;
    }

    addExtensionCommandRegistration({
      registry,
      record,
      commandName: normalized.commandName,
      entry: normalized.entry,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
    policy?: PluginTypedHookPolicy,
  ) => {
    const normalized = resolveExtensionTypedHookRegistration({
      ownerPluginId: record.id,
      ownerSource: record.source,
      hookName,
      handler,
      priority: opts?.priority,
    });
    if (!normalized.ok) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: normalized.message,
      });
      return;
    }
    let effectiveHandler = normalized.entry.handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(normalized.hookName)) {
      if (normalized.hookName === "before_prompt_build") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${normalized.hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        return;
      }
      if (normalized.hookName === "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${normalized.hookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        effectiveHandler = constrainLegacyPromptInjectionHook(
          handler as PluginHookHandlerMap["before_agent_start"],
        ) as PluginHookHandlerMap[K];
      }
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      ...normalized.entry,
      pluginId: record.id,
      hookName: normalized.hookName,
      handler: effectiveHandler,
    } as TypedPluginHookRegistration);
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
    },
  ): OpenClawPluginApi => {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: registryParams.runtime,
      logger: normalizeLogger(registryParams.logger),
      registerTool: (tool, opts) => registerTool(record, tool, opts),
      registerHook: (events, handler, opts) =>
        registerHook(record, events, handler, opts, params.config),
      registerHttpRoute: (params) => registerHttpRoute(record, params),
      registerChannel: (registration) => registerChannel(record, registration),
      registerProvider: (provider) => registerProvider(record, provider),
      registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerService: (service) => registerService(record, service),
      registerCommand: (command) => registerCommand(record, command),
      registerContextEngine: (id, factory) => {
        const result = resolveExtensionContextEngineRegistration({
          engineId: id,
          factory,
        });
        if (!result.ok) {
          pushDiagnostic({
            level: "error",
            pluginId: record.id,
            source: record.source,
            message: result.message,
          });
          return;
        }
        registerContextEngine(result.entry.engineId, result.entry.factory);
      },
      resolvePath: (input: string) => resolveUserPath(input),
      on: (hookName, handler, opts) =>
        registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
    };
  };

  return {
    registry,
    createApi,
    pushDiagnostic,
    registerTool,
    registerChannel,
    registerProvider,
    registerGatewayMethod,
    registerCli,
    registerService,
    registerCommand,
    registerHook,
    registerTypedHook,
  };
}
