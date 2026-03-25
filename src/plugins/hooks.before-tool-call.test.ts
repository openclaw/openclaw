import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookToolContext } from "./types.js";
import type { PluginHookBeforeToolCallResult, PluginHookRegistration } from "./types.js";

function addBeforeToolCallHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookBeforeToolCallResult | Promise<PluginHookBeforeToolCallResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_tool_call",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

const stubCtx: PluginHookToolContext = {
  toolName: "bash",
  agentId: "main",
  sessionKey: "agent:main:main",
};

describe("before_tool_call hook merger — requireApproval", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("propagates requireApproval from a single plugin", async () => {
    addBeforeToolCallHook(registry, "sage", () => ({
      requireApproval: {
        id: "approval-1",
        title: "Sensitive tool",
        description: "This tool does something sensitive",
        severity: "warning",
      },
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    expect(result?.requireApproval).toEqual({
      id: "approval-1",
      title: "Sensitive tool",
      description: "This tool does something sensitive",
      severity: "warning",
      pluginId: "sage",
    });
  });

  it("stamps pluginId from the registration", async () => {
    addBeforeToolCallHook(registry, "my-plugin", () => ({
      requireApproval: {
        id: "a1",
        title: "T",
        description: "D",
      },
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    expect(result?.requireApproval?.pluginId).toBe("my-plugin");
  });

  it("first hook with requireApproval wins when multiple plugins set it", async () => {
    addBeforeToolCallHook(
      registry,
      "plugin-a",
      () => ({
        requireApproval: {
          title: "First",
          description: "First plugin",
        },
      }),
      100,
    );
    addBeforeToolCallHook(
      registry,
      "plugin-b",
      () => ({
        requireApproval: {
          title: "Second",
          description: "Second plugin",
        },
      }),
      50,
    );
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    expect(result?.requireApproval?.title).toBe("First");
    expect(result?.requireApproval?.pluginId).toBe("plugin-a");
  });

  it("does not overwrite pluginId if plugin sets it (stamped by merger)", async () => {
    addBeforeToolCallHook(registry, "actual-plugin", () => ({
      requireApproval: {
        title: "T",
        description: "D",
        pluginId: "should-be-overwritten",
      },
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    // The merger spreads the requireApproval then overwrites pluginId from registration
    expect(result?.requireApproval?.pluginId).toBe("actual-plugin");
  });

  it("merges block and requireApproval from different plugins", async () => {
    addBeforeToolCallHook(
      registry,
      "approver",
      () => ({
        requireApproval: {
          title: "Needs approval",
          description: "Approval needed",
        },
      }),
      100,
    );
    addBeforeToolCallHook(
      registry,
      "blocker",
      () => ({
        block: true,
        blockReason: "blocked",
      }),
      50,
    );
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    expect(result?.block).toBe(true);
    expect(result?.requireApproval?.title).toBe("Needs approval");
  });

  it("returns undefined requireApproval when no plugin sets it", async () => {
    addBeforeToolCallHook(registry, "plain", () => ({
      params: { extra: true },
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, stubCtx);
    expect(result?.requireApproval).toBeUndefined();
  });
});
