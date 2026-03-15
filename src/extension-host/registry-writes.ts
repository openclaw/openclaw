import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type {
  PluginChannelRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistry,
  PluginProviderRegistration,
  PluginServiceRegistration,
  PluginToolRegistration,
} from "../plugins/registry.js";
import type {
  ExtensionHostChannelRegistration,
  ExtensionHostCliRegistration,
  ExtensionHostCommandRegistration,
  ExtensionHostHttpRouteRegistration,
  ExtensionHostProviderRegistration,
  ExtensionHostServiceRegistration,
  ExtensionHostToolRegistration,
} from "./runtime-registrations.js";

export function addExtensionGatewayMethodRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  method: string;
  handler: GatewayRequestHandler;
}): void {
  params.registry.gatewayHandlers[params.method] = params.handler;
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
    params.registry.httpRoutes[params.existingIndex] = params.entry as PluginHttpRouteRegistration;
    return;
  }

  params.record.httpRoutes += 1;
  params.registry.httpRoutes.push(params.entry as PluginHttpRouteRegistration);
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
  params.registry.providers.push(params.entry as PluginProviderRegistration);
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
  params.registry.tools.push(params.entry as PluginToolRegistration);
}

export function addExtensionCliRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  commands: string[];
  entry: ExtensionHostCliRegistration;
}): void {
  params.record.cliCommands.push(...params.commands);
  params.registry.cliRegistrars.push(params.entry as PluginCliRegistration);
}

export function addExtensionServiceRegistration(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  serviceId: string;
  entry: ExtensionHostServiceRegistration;
}): void {
  params.record.services.push(params.serviceId);
  params.registry.services.push(params.entry as PluginServiceRegistration);
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
