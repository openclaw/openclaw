import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookBeforeToolResultEvent, PluginHookToolContext } from "./types.js";
import { createHookRunner } from "./hooks.js";

// Mock AgentToolResult for testing
type MockAgentToolResult = {
  content: string;
  status?: string;
};

function createMockRegistry(): PluginRegistry {
  return {
    typedHooks: [],
    plugins: [],
    channels: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    diagnostics: [],
    memoryPlugins: [],
  };
}

function createMockEvent(): PluginHookBeforeToolResultEvent {
  return {
    toolName: "test-tool",
    toolCallId: "call-123",
    params: { arg1: "value1" },
    content: { content: "original result" } as unknown as MockAgentToolResult,
    isError: false,
    durationMs: 100,
  };
}

function createMockContext(): PluginHookToolContext {
  return {
    toolName: "test-tool",
    agentId: "test-agent",
    sessionKey: "test-session",
  };
}

describe("runBeforeToolResult", () => {
  it("returns undefined when no hooks are registered", async () => {
    const registry = createMockRegistry();
    const runner = createHookRunner(registry);

    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    expect(result).toBeUndefined();
  });

  it("returns hook result when single hook is registered", async () => {
    const registry = createMockRegistry();
    const modifiedResult = { content: "modified result" };

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "test-plugin",
      priority: 0,
      handler: async () => ({
        content: modifiedResult,
      }),
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    expect(result).toEqual({ content: modifiedResult });
  });

  it("respects priority order (higher first)", async () => {
    const registry = createMockRegistry();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "low-priority",
      priority: 1,
      handler: async () => ({
        content: { step: "low" },
        blockReason: "low",
      }),
    });

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "high-priority",
      priority: 10,
      handler: async () => ({
        content: { step: "high" },
        block: true,
      }),
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    // Higher priority should be processed first, but merge should combine them
    expect(result).toBeDefined();
    expect(result?.content).toEqual({ step: "low" });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("low");
  });

  it("can block tool results", async () => {
    const registry = createMockRegistry();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "blocking-plugin",
      priority: 0,
      handler: async () => ({
        block: true,
        blockReason: "Sensitive content detected",
      }),
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("Sensitive content detected");
  });

  it("modifies content when returned by hook", async () => {
    const registry = createMockRegistry();
    const sanitizedContent = { content: "sanitized result" };

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "sanitizer-plugin",
      priority: 0,
      handler: async (_event) => ({
        content: sanitizedContent,
      }),
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    expect(result?.content).toEqual(sanitizedContent);
    expect(result?.block).toBeUndefined();
  });

  it("handles multiple hooks with result merging", async () => {
    const registry = createMockRegistry();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "modifier",
      priority: 5,
      handler: async () => ({
        content: { modified: true },
      }),
    });

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "blocker",
      priority: 1,
      handler: async () => ({
        block: true,
        blockReason: "blocked by second",
      }),
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    // Both hooks should have their effects applied
    expect(result?.content).toEqual({ modified: true });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked by second");
  });

  it("handles hook errors gracefully by default", async () => {
    const registry = createMockRegistry();
    const errorLogger = vi.fn();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "failing-plugin",
      priority: 0,
      handler: async () => {
        throw new Error("Hook failed!");
      },
    });

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "working-plugin",
      priority: 0,
      handler: async () => ({
        content: { recovered: true },
      }),
    });

    const runner = createHookRunner(registry, {
      logger: { error: errorLogger, warn: vi.fn() },
      catchErrors: true,
    });

    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    // Should still get result from working hook
    expect(result?.content).toEqual({ recovered: true });
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining("before_tool_result handler from failing-plugin failed"),
    );
  });

  it("throws on hook error when catchErrors is false", async () => {
    const registry = createMockRegistry();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "failing-plugin",
      priority: 0,
      handler: async () => {
        throw new Error("Hook failed!");
      },
    });

    const runner = createHookRunner(registry, { catchErrors: false });
    const event = createMockEvent();
    const ctx = createMockContext();

    await expect(runner.runBeforeToolResult(event, ctx)).rejects.toThrow();
  });

  it("handles empty result from hook", async () => {
    const registry = createMockRegistry();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "silent-plugin",
      priority: 0,
      handler: async () => {
        // Returns nothing
      },
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    const result = await runner.runBeforeToolResult(event, ctx);

    expect(result).toBeUndefined();
  });

  it("hasHooks returns correct value", async () => {
    const registry = createMockRegistry();
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("before_tool_result")).toBe(false);

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "test-plugin",
      priority: 0,
      handler: async () => ({}),
    });

    expect(runner.hasHooks("before_tool_result")).toBe(true);
  });

  it("getHookCount returns correct count", async () => {
    const registry = createMockRegistry();
    const runner = createHookRunner(registry);

    expect(runner.getHookCount("before_tool_result")).toBe(0);

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "plugin-1",
      priority: 0,
      handler: async () => ({}),
    });

    expect(runner.getHookCount("before_tool_result")).toBe(1);

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "plugin-2",
      priority: 0,
      handler: async () => ({}),
    });

    expect(runner.getHookCount("before_tool_result")).toBe(2);
  });

  it("receives correct event and context", async () => {
    const registry = createMockRegistry();
    const receivedEvent = vi.fn();
    const receivedCtx = vi.fn();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "spy-plugin",
      priority: 0,
      handler: async (event, ctx) => {
        receivedEvent(event);
        receivedCtx(ctx);
        return {};
      },
    });

    const runner = createHookRunner(registry);
    const event = createMockEvent();
    const ctx = createMockContext();

    await runner.runBeforeToolResult(event, ctx);

    expect(receivedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "test-tool",
        toolCallId: "call-123",
        isError: false,
        durationMs: 100,
      }),
    );

    expect(receivedCtx).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "test-tool",
        agentId: "test-agent",
        sessionKey: "test-session",
      }),
    );
  });

  it("handles isError flag correctly", async () => {
    const registry = createMockRegistry();
    const receivedEvent = vi.fn();

    registry.typedHooks.push({
      hookName: "before_tool_result",
      pluginId: "error-handler",
      priority: 0,
      handler: async (event) => {
        receivedEvent(event);
        return { content: event.isError ? "error handled" : "success handled" };
      },
    });

    const runner = createHookRunner(registry);

    // Test error case
    const errorEvent = { ...createMockEvent(), isError: true };
    const errorResult = await runner.runBeforeToolResult(errorEvent, createMockContext());
    expect(errorResult?.content).toBe("error handled");

    // Test success case
    const successEvent = { ...createMockEvent(), isError: false };
    const successResult = await runner.runBeforeToolResult(successEvent, createMockContext());
    expect(successResult?.content).toBe("success handled");
  });
});
