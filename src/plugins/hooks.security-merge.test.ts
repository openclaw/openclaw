import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";
import { createHookRunner } from "./hooks.js";

function registryWithHooks(hooks: PluginHookRegistration[]): PluginRegistry {
  return {
    // Only typedHooks are used by createHookRunner; other fields are irrelevant in this test.
    typedHooks: hooks,
  } as unknown as PluginRegistry;
}

describe("hook security merge semantics", () => {
  it("keeps higher-priority block=true when lower-priority hook returns false", async () => {
    const runner = createHookRunner(
      registryWithHooks([
        {
          pluginId: "high-priority-guard",
          hookName: "before_tool_call",
          source: "test",
          priority: 100,
          async handler() {
            return { block: true, blockReason: "blocked by guard" };
          },
        },
        {
          pluginId: "low-priority-plugin",
          hookName: "before_tool_call",
          source: "test",
          priority: 0,
          async handler() {
            return { block: false, blockReason: "allow override" };
          },
        },
      ]),
    );

    const result = await runner.runBeforeToolCall(
      { toolName: "exec", params: {} },
      { toolName: "exec", agentId: "main", sessionKey: "main" },
    );

    expect(result).toEqual({
      block: true,
      blockReason: "blocked by guard",
    });
  });

  it("keeps higher-priority cancel=true when lower-priority hook returns false", async () => {
    const runner = createHookRunner(
      registryWithHooks([
        {
          pluginId: "high-priority-guard",
          hookName: "message_sending",
          source: "test",
          priority: 100,
          async handler() {
            return { cancel: true };
          },
        },
        {
          pluginId: "low-priority-plugin",
          hookName: "message_sending",
          source: "test",
          priority: 0,
          async handler() {
            return { cancel: false, content: "modified by low priority" };
          },
        },
      ]),
    );

    const result = await runner.runMessageSending(
      { to: "user", content: "hello" },
      { channelId: "telegram" },
    );

    expect(result).toEqual({
      cancel: true,
      content: "modified by low priority",
    });
  });
});
