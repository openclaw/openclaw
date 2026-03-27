import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { getPluginRuntimeRequestAttributionScope } from "./runtime/request-attribution-scope.js";
import type { PluginHookRegistration } from "./types.js";

describe("hook request attribution scope", () => {
  it("sets request attribution scope while async hooks execute", async () => {
    const registry = createEmptyPluginRegistry();
    let seenScope: ReturnType<typeof getPluginRuntimeRequestAttributionScope>;

    registry.typedHooks.push({
      pluginId: "test-plugin",
      hookName: "before_agent_start",
      priority: 0,
      source: "test",
      handler: async () => {
        await Promise.resolve();
        seenScope = getPluginRuntimeRequestAttributionScope();
      },
    } as PluginHookRegistration<"before_agent_start">);

    const runner = createHookRunner(registry);
    await runner.runBeforeAgentStart(
      { prompt: "hello", messages: [] },
      { agentId: "agent-alpha", sessionKey: "agent:agent-alpha:web:conv-1" },
    );

    expect(seenScope).toEqual({
      agentId: "agent-alpha",
      sessionKey: "agent:agent-alpha:web:conv-1",
    });
  });
});
