import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "./registry.js";
import { createHookRunner } from "./hooks.js";

function createMockRegistry(hooks: PluginRegistry["typedHooks"] = []): PluginRegistry {
  return {
    typedHooks: hooks,
    hooks: hooks as PluginRegistry["hooks"],
    plugins: [],
    tools: [],
    gatewayHandlers: [],
    services: [],
  } as unknown as PluginRegistry;
}

describe("createHookRunner", () => {
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  // =========================================================================
  // Agent Hooks
  // =========================================================================

  describe("runBeforeAgentStart", () => {
    it("returns undefined when no hooks are registered", async () => {
      const runner = createHookRunner(createMockRegistry(), { logger });
      const result = await runner.runBeforeAgentStart(
        { prompt: "hello", messages: [] },
        { agentId: "main", sessionKey: "main" },
      );
      expect(result).toBeUndefined();
    });

    it("merges prependContext from multiple hooks", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "a",
          hookName: "before_agent_start",
          handler: async () => ({ prependContext: "from-a" }),
          priority: 10,
        },
        {
          pluginId: "b",
          hookName: "before_agent_start",
          handler: async () => ({ prependContext: "from-b" }),
          priority: 5,
        },
      ]);
      const runner = createHookRunner(registry, { logger });
      const result = await runner.runBeforeAgentStart(
        { prompt: "hello", messages: [] },
        { agentId: "main" },
      );
      expect(result?.prependContext).toBe("from-a\n\nfrom-b");
    });
  });

  describe("runAgentEnd", () => {
    it("fires all handlers in parallel", async () => {
      const order: string[] = [];
      const registry = createMockRegistry([
        {
          pluginId: "a",
          hookName: "agent_end",
          handler: async () => {
            order.push("a");
          },
          priority: 10,
        },
        {
          pluginId: "b",
          hookName: "agent_end",
          handler: async () => {
            order.push("b");
          },
          priority: 5,
        },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runAgentEnd(
        { messages: [], success: true, durationMs: 100 },
        { agentId: "main" },
      );
      expect(order).toContain("a");
      expect(order).toContain("b");
    });
  });

  // =========================================================================
  // Compaction Hooks
  // =========================================================================

  describe("runBeforeCompaction", () => {
    it("fires handler with correct event", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "before_compaction", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runBeforeCompaction(
        { messageCount: 50, tokenCount: 10000 },
        { agentId: "main", sessionKey: "main" },
      );
      expect(handler).toHaveBeenCalledWith(
        { messageCount: 50, tokenCount: 10000 },
        { agentId: "main", sessionKey: "main" },
      );
    });
  });

  describe("runAfterCompaction", () => {
    it("fires handler with correct event", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "after_compaction", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runAfterCompaction(
        { messageCount: 10, tokenCount: 2000, compactedCount: 40 },
        { agentId: "main", sessionKey: "main" },
      );
      expect(handler).toHaveBeenCalledWith(
        { messageCount: 10, tokenCount: 2000, compactedCount: 40 },
        { agentId: "main", sessionKey: "main" },
      );
    });
  });

  // =========================================================================
  // Message Hooks
  // =========================================================================

  describe("runMessageReceived", () => {
    it("fires handler with message data", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "message_received", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runMessageReceived(
        { from: "user1", content: "hello", timestamp: 123 },
        { channelId: "telegram", conversationId: "chat1" },
      );
      expect(handler).toHaveBeenCalledWith(
        { from: "user1", content: "hello", timestamp: 123 },
        { channelId: "telegram", conversationId: "chat1" },
      );
    });
  });

  describe("runMessageSending", () => {
    it("returns modified content", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "test",
          hookName: "message_sending",
          handler: async () => ({ content: "modified" }),
          priority: 0,
        },
      ]);
      const runner = createHookRunner(registry, { logger });
      const result = await runner.runMessageSending(
        { to: "user1", content: "original" },
        { channelId: "telegram" },
      );
      expect(result?.content).toBe("modified");
    });

    it("returns cancel flag", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "test",
          hookName: "message_sending",
          handler: async () => ({ cancel: true }),
          priority: 0,
        },
      ]);
      const runner = createHookRunner(registry, { logger });
      const result = await runner.runMessageSending(
        { to: "user1", content: "spam" },
        { channelId: "telegram" },
      );
      expect(result?.cancel).toBe(true);
    });

    it("returns undefined when no hooks registered", async () => {
      const runner = createHookRunner(createMockRegistry(), { logger });
      const result = await runner.runMessageSending(
        { to: "user1", content: "hello" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });
  });

  describe("runMessageSent", () => {
    it("fires handler with delivery result", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "message_sent", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runMessageSent(
        { to: "user1", content: "hello", success: true },
        { channelId: "telegram" },
      );
      expect(handler).toHaveBeenCalledWith(
        { to: "user1", content: "hello", success: true },
        { channelId: "telegram" },
      );
    });

    it("fires handler with error on failure", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "message_sent", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runMessageSent(
        { to: "user1", content: "hello", success: false, error: "network error" },
        { channelId: "telegram" },
      );
      expect(handler).toHaveBeenCalledWith(
        { to: "user1", content: "hello", success: false, error: "network error" },
        { channelId: "telegram" },
      );
    });
  });

  // =========================================================================
  // Tool Hooks
  // =========================================================================

  describe("runBeforeToolCall", () => {
    it("allows blocking tool calls", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "test",
          hookName: "before_tool_call",
          handler: async () => ({ block: true, blockReason: "forbidden" }),
          priority: 0,
        },
      ]);
      const runner = createHookRunner(registry, { logger });
      const result = await runner.runBeforeToolCall(
        { toolName: "exec", params: { cmd: "rm" } },
        { toolName: "exec", agentId: "main" },
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toBe("forbidden");
    });
  });

  describe("runAfterToolCall", () => {
    it("fires handler with tool result", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "after_tool_call", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runAfterToolCall(
        { toolName: "read", params: { path: "/tmp" }, result: "content", durationMs: 50 },
        { toolName: "read", agentId: "main" },
      );
      expect(handler).toHaveBeenCalledWith(
        { toolName: "read", params: { path: "/tmp" }, result: "content", durationMs: 50 },
        { toolName: "read", agentId: "main" },
      );
    });

    it("fires handler with error info", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "after_tool_call", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runAfterToolCall(
        { toolName: "exec", params: {}, error: "ENOENT", durationMs: 10 },
        { toolName: "exec" },
      );
      expect(handler).toHaveBeenCalledWith(
        { toolName: "exec", params: {}, error: "ENOENT", durationMs: 10 },
        { toolName: "exec" },
      );
    });
  });

  // =========================================================================
  // Session Hooks
  // =========================================================================

  describe("runSessionStart", () => {
    it("fires handler with session info", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "session_start", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runSessionStart(
        { sessionId: "sess-123" },
        { agentId: "main", sessionId: "sess-123" },
      );
      expect(handler).toHaveBeenCalledWith(
        { sessionId: "sess-123" },
        { agentId: "main", sessionId: "sess-123" },
      );
    });

    it("fires handler with resumedFrom", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "session_start", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runSessionStart(
        { sessionId: "sess-456", resumedFrom: "sess-123" },
        { sessionId: "sess-456" },
      );
      expect(handler).toHaveBeenCalledWith(
        { sessionId: "sess-456", resumedFrom: "sess-123" },
        { sessionId: "sess-456" },
      );
    });
  });

  describe("runSessionEnd", () => {
    it("fires handler with session end info", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "session_end", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runSessionEnd(
        { sessionId: "sess-123", messageCount: 42, durationMs: 5000 },
        { agentId: "main", sessionId: "sess-123" },
      );
      expect(handler).toHaveBeenCalledWith(
        { sessionId: "sess-123", messageCount: 42, durationMs: 5000 },
        { agentId: "main", sessionId: "sess-123" },
      );
    });
  });

  // =========================================================================
  // Gateway Hooks
  // =========================================================================

  describe("runGatewayStart", () => {
    it("fires handler with port", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "gateway_start", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runGatewayStart({ port: 3000 }, { port: 3000 });
      expect(handler).toHaveBeenCalledWith({ port: 3000 }, { port: 3000 });
    });
  });

  describe("runGatewayStop", () => {
    it("fires handler with reason", async () => {
      const handler = vi.fn();
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "gateway_stop", handler, priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      await runner.runGatewayStop({ reason: "shutdown" }, { port: 3000 });
      expect(handler).toHaveBeenCalledWith({ reason: "shutdown" }, { port: 3000 });
    });
  });

  // =========================================================================
  // Error Handling
  // =========================================================================

  describe("error handling", () => {
    it("catches and logs errors in void hooks by default", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "bad",
          hookName: "gateway_start",
          handler: async () => {
            throw new Error("boom");
          },
          priority: 0,
        },
      ]);
      const runner = createHookRunner(registry, { logger, catchErrors: true });
      await runner.runGatewayStart({ port: 3000 }, { port: 3000 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("gateway_start handler from bad failed"),
      );
    });

    it("throws errors in void hooks when catchErrors is false", async () => {
      const registry = createMockRegistry([
        {
          pluginId: "bad",
          hookName: "session_start",
          handler: async () => {
            throw new Error("fail");
          },
          priority: 0,
        },
      ]);
      const runner = createHookRunner(registry, { logger, catchErrors: false });
      await expect(
        runner.runSessionStart({ sessionId: "s1" }, { sessionId: "s1" }),
      ).rejects.toThrow("session_start handler from bad failed");
    });
  });

  // =========================================================================
  // Utility Methods
  // =========================================================================

  describe("hasHooks", () => {
    it("returns true when hooks are registered", () => {
      const registry = createMockRegistry([
        { pluginId: "test", hookName: "gateway_start", handler: vi.fn(), priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      expect(runner.hasHooks("gateway_start")).toBe(true);
      expect(runner.hasHooks("gateway_stop")).toBe(false);
    });
  });

  describe("getHookCount", () => {
    it("returns correct count", () => {
      const registry = createMockRegistry([
        { pluginId: "a", hookName: "message_sent", handler: vi.fn(), priority: 0 },
        { pluginId: "b", hookName: "message_sent", handler: vi.fn(), priority: 0 },
        { pluginId: "c", hookName: "gateway_start", handler: vi.fn(), priority: 0 },
      ]);
      const runner = createHookRunner(registry, { logger });
      expect(runner.getHookCount("message_sent")).toBe(2);
      expect(runner.getHookCount("gateway_start")).toBe(1);
      expect(runner.getHookCount("session_start")).toBe(0);
    });
  });
});
