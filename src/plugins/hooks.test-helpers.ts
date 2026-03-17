import type { PluginRegistry } from "./registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

export function createMockPluginRegistry(
  hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
): PluginRegistry {
  return {
    plugins: [
      {
        id: "test-plugin",
        name: "Test Plugin",
        source: "test",
        origin: "workspace",
        enabled: true,
        status: "loaded",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: hooks.length,
        configSchema: false,
      },
    ],
    hooks: hooks as never[],
    typedHooks: hooks.map((h) => ({
      pluginId: "test-plugin",
      hookName: h.hookName,
      handler: h.handler,
      priority: 0,
      source: "test",
    })),
    tools: [],
    httpRoutes: [],
    channelRegistrations: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    providers: [],
    commands: [],
  } as unknown as PluginRegistry;
}

export const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
  sessionId: "test-session-id",
  workspaceDir: "/tmp/openclaw-test",
  messageProvider: "test",
};

export function addTestHook(params: {
  registry: PluginRegistry;
  pluginId: string;
  hookName: PluginHookRegistration["hookName"];
  handler: PluginHookRegistration["handler"];
  priority?: number;
}) {
  params.registry.typedHooks.push({
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: params.handler,
    priority: params.priority ?? 0,
    source: "test",
  } as PluginHookRegistration);
}
