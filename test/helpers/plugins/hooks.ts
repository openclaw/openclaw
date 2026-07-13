/** Test-only helpers for exercising plugin hook behavior. */
import { createHookRunner } from "../../../src/plugins/hooks.js";
import { addTestHook, createMockPluginRegistry } from "../../../src/plugins/hooks.test-helpers.js";
import type { PluginRegistry } from "../../../src/plugins/registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "../../../src/plugins/types.js";

export { addTestHook, createMockPluginRegistry };
export type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
} from "../../../src/plugins/hook-types.js";
export type PluginTargetedInboundClaimOutcome = Awaited<
  ReturnType<ReturnType<typeof createHookRunner>["runInboundClaimForPluginOutcome"]>
>;

export const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext = {
  runId: "test-run-id",
  agentId: "test-agent",
  sessionKey: "test-session",
  sessionId: "test-session-id",
  workspaceDir: "/tmp/openclaw-test",
  messageProvider: "test",
};

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
  for (const { pluginId, result, priority, handler } of params.hooks) {
    addTestHook({
      registry,
      pluginId,
      hookName: params.hookName,
      handler: (handler ?? (() => result)) as PluginHookRegistration["handler"],
      ...(priority !== undefined ? { priority } : {}),
    });
  }
}

export function createHookRunnerWithRegistry(
  hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
    priority?: number;
    timeoutMs?: number;
  }>,
  options?: Parameters<typeof createHookRunner>[1],
) {
  const registry = createMockPluginRegistry(hooks);
  return {
    registry,
    runner: createHookRunner(registry, options),
  };
}
