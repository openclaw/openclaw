import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createDefaultGatewayTestChannels } from "./test-helpers.channels.js";
import { createDefaultGatewayTestSpeechProviders } from "./test-helpers.speech.js";

function createStubPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: createDefaultGatewayTestChannels(),
    channelSetups: [],
    providers: [],
    speechProviders: createDefaultGatewayTestSpeechProviders(),
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    migrationProviders: [],
    codexAppServerExtensionFactories: [],
    agentToolResultMiddlewares: [],
    memoryEmbeddingProviders: [],
    textTransforms: [],
    agentHarnesses: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    gatewayDiscoveryServices: [],
    commands: [],
    sessionExtensions: [],
    trustedToolPolicies: [],
    toolMetadata: [],
    controlUiDescriptors: [],
    runtimeLifecycles: [],
    agentEventSubscriptions: [],
    sessionSchedulerJobs: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
  };
}

const GATEWAY_TEST_CANVAS_NODE_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

const GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY = Symbol.for(
  "openclaw.gatewayTestHelpers.pluginRegistryState",
);

const pluginRegistryState = resolveGlobalSingleton(GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY, () => ({
  registry: createStubPluginRegistry(),
}));

setActivePluginRegistry(pluginRegistryState.registry);

export function setTestPluginRegistry(registry: PluginRegistry): void {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
}

export function resetTestPluginRegistry(): void {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
}

export function getTestPluginRegistry(): PluginRegistry {
  return pluginRegistryState.registry;
}

export function installGatewayTestCanvasNodeInvokePolicy(): void {
  const registry = getTestPluginRegistry();
  registry.nodeInvokePolicies ??= [];
  if (registry.nodeInvokePolicies.some((entry) => entry.pluginId === "canvas")) {
    return;
  }
  registry.nodeInvokePolicies.push({
    pluginId: "canvas",
    pluginName: "Canvas",
    source: "extensions/canvas/index.ts",
    rootDir: "extensions/canvas",
    pluginConfig: {},
    policy: {
      commands: GATEWAY_TEST_CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  });
}
