import type { PluginRegistry } from "./registry.js";

export function createEmptyPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    channelSetups: [],
    providers: [],
    cliBackends: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    webSearchProviders: [],
    mediaProviders: [],
    gatewayHandlers: {},
    gatewayMethodScopes: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
  };
}
