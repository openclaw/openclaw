import path from "node:path";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import type { HookEntry } from "../hooks/types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginHttpHandler,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginHookOptions,
  ProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolContext,
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
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import { registerPluginCommand } from "./commands.js";
import { normalizePluginHttpPath } from "./http-path.js";

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

export type PluginHttpRegistration = {
  pluginId: string;
  handler: OpenClawPluginHttpHandler;
  source: string;
};

export type PluginHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
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
  error?: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpHandlers: number;
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
  httpHandlers: PluginHttpRegistration[];
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

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry: PluginRegistry = {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  // Security: Track if registry has been finalized (immutable after plugin loading)
  let isFinalized = false;

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    // Security: Prevent registration after finalization
    if (isFinalized) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "Cannot register tool after registry is finalized",
      });
      return;
    }

    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: OpenClawPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      factory,
      names: normalized,
      optional,
      source: record.source,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
  ) => {
    const eventList = Array.isArray(events) ? events : [events];
    const normalizedEvents = eventList.map((event) => event.trim()).filter(Boolean);
    const entry = opts?.entry ?? null;
    const name = entry?.hook.name ?? opts?.name?.trim();
    if (!name) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "hook registration missing name",
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          metadata: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }

    for (const event of normalizedEvents) {
      registerInternalHook(event, handler);
    }
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method already registered: ${trimmed}`,
      });
      return;
    }
    registry.gatewayHandlers[trimmed] = handler;
    record.gatewayMethods.push(trimmed);
  };

  const registerHttpHandler = (record: PluginRecord, handler: OpenClawPluginHttpHandler) => {
    record.httpHandlers += 1;
    registry.httpHandlers.push({
      pluginId: record.id,
      handler,
      source: record.source,
    });
  };

  const registerHttpRoute = (
    record: PluginRecord,
    params: { path: string; handler: OpenClawPluginHttpRouteHandler },
  ) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "http route registration missing path",
      });
      return;
    }
    if (registry.httpRoutes.some((entry) => entry.path === normalizedPath)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route already registered: ${normalizedPath}`,
      });
      return;
    }
    record.httpHandlers += 1;
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      source: record.source,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
  ) => {
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalized.plugin;
    const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "channel registration missing id",
      });
      return;
    }
    record.channelIds.push(id);
    registry.channels.push({
      pluginId: record.id,
      plugin,
      dock: normalized.dock,
      source: record.source,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "provider registration missing id",
      });
      return;
    }
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.providerIds.push(id);
    registry.providers.push({
      pluginId: record.id,
      provider,
      source: record.source,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => {
    const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      pluginId: record.id,
      register: registrar,
      commands,
      source: record.source,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const id = service.id.trim();
    if (!id) {
      return;
    }
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      service,
      source: record.source,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const name = command.name.trim();
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "command registration missing name",
      });
      return;
    }

    // Register with the plugin command system (validates name and checks for duplicates)
    const result = registerPluginCommand(record.id, command);
    if (!result.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: ${result.error}`,
      });
      return;
    }

    record.commands.push(name);
    registry.commands.push({
      pluginId: record.id,
      command,
      source: record.source,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => {
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName,
      handler,
      priority: opts?.priority,
      source: record.source,
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
      registerHttpHandler: (handler) => registerHttpHandler(record, handler),
      registerHttpRoute: (params) => registerHttpRoute(record, params),
      registerChannel: (registration) => registerChannel(record, registration),
      registerProvider: (provider) => registerProvider(record, provider),
      registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerService: (service) => registerService(record, service),
      registerCommand: (command) => registerCommand(record, command),
      resolvePath: (input: string) => resolveUserPath(input),
      on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
    };
  };

  /**
   * Finalizes the registry, making it immutable and freezing all registered data.
   * This prevents plugins from tampering with each other after initialization.
   * CVSS 8.5 mitigation for cross-plugin tampering vulnerability.
   */
  const finalizeRegistry = () => {
    if (isFinalized) {
      return;
    }

    isFinalized = true;

    // Deep freeze all plugin records to prevent modification
    for (const plugin of registry.plugins) {
      Object.freeze(plugin);
      if (plugin.toolNames) {
        Object.freeze(plugin.toolNames);
      }
      if (plugin.hookNames) {
        Object.freeze(plugin.hookNames);
      }
      if (plugin.channelIds) {
        Object.freeze(plugin.channelIds);
      }
      if (plugin.providerIds) {
        Object.freeze(plugin.providerIds);
      }
      if (plugin.gatewayMethods) {
        Object.freeze(plugin.gatewayMethods);
      }
      if (plugin.cliCommands) {
        Object.freeze(plugin.cliCommands);
      }
      if (plugin.services) {
        Object.freeze(plugin.services);
      }
      if (plugin.commands) {
        Object.freeze(plugin.commands);
      }
      if (plugin.configUiHints) {
        Object.freeze(plugin.configUiHints);
      }
      if (plugin.configJsonSchema) {
        Object.freeze(plugin.configJsonSchema);
      }
    }

    // Freeze all registration arrays and objects
    Object.freeze(registry.plugins);
    Object.freeze(registry.tools);
    Object.freeze(registry.hooks);
    Object.freeze(registry.typedHooks);
    Object.freeze(registry.channels);
    Object.freeze(registry.providers);
    Object.freeze(registry.gatewayHandlers);
    Object.freeze(registry.httpHandlers);
    Object.freeze(registry.httpRoutes);
    Object.freeze(registry.cliRegistrars);
    Object.freeze(registry.services);
    Object.freeze(registry.commands);
    Object.freeze(registry.diagnostics);

    // Freeze the registry itself
    Object.freeze(registry);

    registryParams.logger.info?.("[plugins] Registry finalized and frozen");
  };

  /**
   * Checks if the registry has been finalized.
   */
  const isFinalizedRegistry = () => isFinalized;

  /**
   * Gets plugin data with access control.
   * Plugins can only access their own full data; others get limited public API.
   *
   * @param pluginId - The plugin ID to retrieve
   * @param requesterId - The ID of the plugin requesting access
   * @returns Plugin record or null if not found/unauthorized
   */
  const getPluginData = (pluginId: string, requesterId?: string): PluginRecord | null => {
    const plugin = registry.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      return null;
    }

    // If requesting own data, return full record (frozen after finalization)
    if (requesterId === pluginId) {
      return plugin;
    }

    // Security: Other plugins only get limited public data
    // Don't expose internal configuration, source paths, or sensitive fields
    if (isFinalized) {
      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        kind: plugin.kind,
        enabled: plugin.enabled,
        status: plugin.status,
        // Exclude: source, origin, workspaceDir, error, configSchema, configUiHints, configJsonSchema
        source: "",
        origin: "bundled",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: false,
      };
    }

    // Before finalization, return null for cross-plugin access attempts
    return null;
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
    finalizeRegistry,
    isFinalizedRegistry,
    getPluginData,
  };
}
