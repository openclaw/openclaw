import { registerPluginInteractiveHandler } from "../../plugins/interactive.js";
import type { PluginRecord, PluginRegistry, PluginRegistryParams } from "../../plugins/registry.js";
import type {
  PluginDiagnostic,
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginInteractiveHandlerRegistration,
  ProviderPlugin,
} from "../../plugins/types.js";
import {
  addExtensionCommandRegistration,
  addExtensionProviderRegistration,
} from "../registry-writes.js";
import { createExtensionHostPluginApi } from "./plugin-api.js";
import {
  resolveExtensionHostCommandCompatibility,
  resolveExtensionHostProviderCompatibility,
} from "./plugin-registry-compat.js";
import {
  createExtensionHostPluginRegistrationActions,
  type PluginTypedHookPolicy,
} from "./plugin-registry-registrations.js";

export function createExtensionHostPluginRegistry(params: {
  registry: PluginRegistry;
  registryParams: PluginRegistryParams;
}) {
  const { registry, registryParams } = params;
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));
  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };
  const actions = createExtensionHostPluginRegistrationActions({
    registry,
    coreGatewayMethods,
  });

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const result = resolveExtensionHostProviderCompatibility({
      registry,
      record,
      provider,
    });
    if (!result.ok) {
      return;
    }
    addExtensionProviderRegistration({
      registry,
      record,
      providerId: result.providerId,
      entry: result.entry,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const normalized = resolveExtensionHostCommandCompatibility({ registry, record, command });
    if (!normalized.ok) {
      return;
    }
    addExtensionCommandRegistration({
      registry,
      record,
      commandName: normalized.commandName,
      entry: normalized.entry,
    });
  };

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
    },
  ): OpenClawPluginApi => {
    return createExtensionHostPluginApi({
      record,
      runtime: registryParams.runtime,
      logger: registryParams.logger,
      config: params.config,
      pluginConfig: params.pluginConfig,
      registerTool: (tool, opts) => actions.registerTool(record, tool, opts),
      registerHook: (events, handler, opts) =>
        actions.registerHook(record, events, handler, opts, params.config),
      registerHttpRoute: (routeParams) => actions.registerHttpRoute(record, routeParams),
      registerChannel: (registration) => actions.registerChannel(record, registration as never),
      registerProvider: (provider) => registerProvider(record, provider),
      registerGatewayMethod: (method, handler) =>
        actions.registerGatewayMethod(record, method, handler),
      registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => {
        const result = registerPluginInteractiveHandler(record.id, registration, {
          pluginName: record.name,
          pluginRoot: record.rootDir,
        });
        if (!result.ok) {
          pushDiagnostic({
            level: "warn",
            pluginId: record.id,
            source: record.source,
            message: result.error ?? "interactive handler registration failed",
          });
        }
      },
      registerCli: (registrar, opts) => actions.registerCli(record, registrar, opts),
      registerService: (service) => actions.registerService(record, service),
      registerCommand: (command) => registerCommand(record, command),
      registerContextEngine: (id, factory) => actions.registerContextEngine(record, id, factory),
      on: (hookName, handler, opts) =>
        actions.registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
    });
  };

  return {
    registry,
    createApi,
    pushDiagnostic,
    registerTool: actions.registerTool,
    registerChannel: actions.registerChannel,
    registerProvider,
    registerGatewayMethod: actions.registerGatewayMethod,
    registerCli: actions.registerCli,
    registerService: actions.registerService,
    registerCommand,
    registerHook: actions.registerHook,
    registerTypedHook: actions.registerTypedHook,
  };
}
