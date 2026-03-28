import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

export function createMockPluginRegistry(
  hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
): PluginRegistry {
  return {
    plugins: [
      createPluginRecord({
        id: "test-plugin",
        name: "Test Plugin",
        source: "test",
        hookCount: hooks.length,
      }),
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
    channels: [],
    channelSetups: [],
    providers: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    webSearchProviders: [],
    httpRoutes: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  } as unknown as PluginRegistry;
}

export const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext = {
  runId: "test-run-id",
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

export function addTestHooks(
  registry: PluginRegistry,
  hooks: ReadonlyArray<{
    pluginId: string;
    hookName: PluginHookRegistration["hookName"];
    handler: PluginHookRegistration["handler"];
    priority?: number;
  }>,
) {
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: hook.hookName,
      handler: hook.handler,
      ...(hook.priority !== undefined ? { priority: hook.priority } : {}),
    });
  }
}

export function addStaticTestHooks<TResult>(
  registry: PluginRegistry,
  params: {
    hookName: PluginHookRegistration["hookName"];
    hooks: ReadonlyArray<{
      pluginId: string;
      result: TResult;
      priority?: number;
      handler?: () => TResult | Promise<TResult>;
    }>;
  },
) {
  addTestHooks(
    registry,
    params.hooks.map(({ pluginId, result, priority, handler }) => ({
      pluginId,
      hookName: params.hookName,
      handler: (handler ?? (() => result)) as PluginHookRegistration["handler"],
      ...(priority !== undefined ? { priority } : {}),
    })),
  );
}

export function createHookRunnerWithRegistry(
  hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
  options?: Parameters<typeof createHookRunner>[1],
) {
  const registry = createMockPluginRegistry(hooks);
  return {
    registry,
    runner: createHookRunner(registry, options),
  };
}
