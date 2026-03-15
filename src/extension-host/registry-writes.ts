import { registerContextEngine, type ContextEngineFactory } from "../context-engine/registry.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type {
  PluginChannelRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginHookRegistration,
  PluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistry,
  PluginProviderRegistration,
  PluginServiceRegistration,
  PluginToolRegistration,
} from "../plugins/registry.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "../plugins/types.js";
import type {
  ExtensionHostChannelRegistration,
  ExtensionHostCliRegistration,
  ExtensionHostCommandRegistration,
  ExtensionHostContextEngineRegistration,
  ExtensionHostLegacyHookRegistration,
  ExtensionHostHttpRouteRegistration,
  ExtensionHostProviderRegistration,
  ExtensionHostServiceRegistration,
  ExtensionHostToolRegistration,
} from "./runtime-registrations.js";
import {
  addExtensionHostCliRegistration,
  addExtensionHostHttpRoute,
  addExtensionHostProviderRegistration,
  addExtensionHostServiceRegistration,
  addExtensionHostToolRegistration,
  replaceExtensionHostHttpRoute,
  setExtensionHostGatewayHandler,
} from "./runtime-registry.js";

export function addExtensionGatewayMethodRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  method: string;
  handler: GatewayRequestHandler;
}): void {
  setExtensionHostGatewayHandler({
    registry: params.registry,
    method: params.method,
    handler: params.handler,
  });
  params.record.gatewayMethods.push(params.method);
}

export function addExtensionHttpRouteRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  entry: ExtensionHostHttpRouteRegistration;
  action: "replace" | "append";
  existingIndex?: number;
}): void {
  if (params.action === "replace") {
    if (params.existingIndex === undefined) {
      return;
    }
    replaceExtensionHostHttpRoute({
      registry: params.registry,
      index: params.existingIndex,
      entry: params.entry as PluginHttpRouteRegistration,
    });
    return;
  }

  params.record.httpRoutes += 1;
  addExtensionHostHttpRoute(params.registry, params.entry as PluginHttpRouteRegistration);
}

export function addExtensionChannelRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  channelId: string;
  entry: ExtensionHostChannelRegistration;
}): void {
  params.record.channelIds.push(params.channelId);
  params.registry.channels.push(params.entry as PluginChannelRegistration);
}

export function addExtensionProviderRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  providerId: string;
  entry: ExtensionHostProviderRegistration;
}): void {
  params.record.providerIds.push(params.providerId);
  addExtensionHostProviderRegistration(params.registry, params.entry as PluginProviderRegistration);
}

export function addExtensionLegacyHookRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  hookName: string;
  entry: ExtensionHostLegacyHookRegistration;
  events: string[];
}): void {
  params.record.hookNames.push(params.hookName);
  params.registry.hooks.push({
    pluginId: params.entry.pluginId,
    entry: params.entry.entry,
    events: params.events,
    source: params.entry.source,
  } as PluginHookRegistration);
}

export function addExtensionTypedHookRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  entry: TypedPluginHookRegistration;
}): void {
  params.record.hookCount += 1;
  params.registry.typedHooks.push(params.entry);
}

export function addExtensionToolRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  names: string[];
  entry: ExtensionHostToolRegistration;
}): void {
  if (params.names.length > 0) {
    params.record.toolNames.push(...params.names);
  }
  addExtensionHostToolRegistration(params.registry, params.entry as PluginToolRegistration);
}

export function addExtensionCliRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  commands: string[];
  entry: ExtensionHostCliRegistration;
}): void {
  params.record.cliCommands.push(...params.commands);
  addExtensionHostCliRegistration(params.registry, params.entry as PluginCliRegistration);
}

export function addExtensionServiceRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  serviceId: string;
  entry: ExtensionHostServiceRegistration;
}): void {
  params.record.services.push(params.serviceId);
  addExtensionHostServiceRegistration(params.registry, params.entry as PluginServiceRegistration);
}

export function addExtensionCommandRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  commandName: string;
  entry: ExtensionHostCommandRegistration;
}): void {
  params.record.commands.push(params.commandName);
  params.registry.commands.push(params.entry as PluginCommandRegistration);
}

export function addExtensionContextEngineRegistration(params: {
  entry: ExtensionHostContextEngineRegistration;
  registerEngine?: (engineId: string, factory: ContextEngineFactory) => void;
}): void {
  const registerEngine = params.registerEngine ?? registerContextEngine;
  registerEngine(params.entry.engineId, params.entry.factory);
}
