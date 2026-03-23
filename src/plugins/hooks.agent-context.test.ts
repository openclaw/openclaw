/**
 * Tests for agent context (sessionKey, agentId) in hook events
 *
 * Validates that sessionKey and agentId are correctly passed to
 * agent_end and before_agent_start hook handlers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

function addAgentEndHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (event: {
    messages: unknown[];
    success: boolean;
    sessionKey?: string;
    agentId?: string;
  }) => void | Promise<void>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "agent_end",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

function addBeforeAgentStartHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (event: {
    prompt: string;
    messages?: unknown[];
    sessionKey?: string;
    agentId?: string;
  }) => void | Promise<void>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_agent_start",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

describe("hook events include sessionKey and agentId", () => {
  let registry: PluginRegistry;
  const stubCtx = TEST_PLUGIN_AGENT_CTX;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  describe("agent_end hook", () => {
    it("receives sessionKey and agentId in event", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      addAgentEndHook(registry, "memory-plugin", handler);

      const runner = createHookRunner(registry);
      const testMessages = [{ role: "user", content: "hello" }];

      await runner.runAgentEnd(
        {
          messages: testMessages,
          success: true,
          sessionKey: "agent:assistant-beta:main",
          agentId: "assistant-beta",
        },
        stubCtx,
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: testMessages,
          success: true,
          sessionKey: "agent:assistant-beta:main",
          agentId: "assistant-beta",
        }),
        stubCtx,
      );
    });

    it("works with default values when sessionKey and agentId are not provided", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      addAgentEndHook(registry, "memory-plugin", handler);

      const runner = createHookRunner(registry);
      const testMessages = [{ role: "user", content: "hello" }];

      // Call without sessionKey and agentId (backward compatibility)
      await runner.runAgentEnd(
        {
          messages: testMessages,
          success: true,
        },
        stubCtx,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toEqual({
        messages: testMessages,
        success: true,
      });
      expect(handler.mock.calls[0]?.[1]).toBe(stubCtx);
    });
  });

  describe("before_agent_start hook", () => {
    it("receives sessionKey and agentId in event", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      addBeforeAgentStartHook(registry, "memory-plugin", handler);

      const runner = createHookRunner(registry);

      await runner.runBeforeAgentStart(
        {
          prompt: "hello",
          messages: [{ role: "user", content: "hello" }],
          sessionKey: "agent:assistant-beta:main",
          agentId: "assistant-beta",
        },
        stubCtx,
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "hello",
          sessionKey: "agent:assistant-beta:main",
          agentId: "assistant-beta",
        }),
        stubCtx,
      );
    });

    it("works with legacy event shape (backward compatibility)", async () => {
      const handler = vi.fn().mockResolvedValue({ prependContext: "context" });

      addBeforeAgentStartHook(registry, "legacy-plugin", handler);

      const runner = createHookRunner(registry);

      // Call with legacy event shape (without sessionKey and agentId)
      await runner.runBeforeAgentStart(
        {
          prompt: "hello",
        },
        stubCtx,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toEqual({
        prompt: "hello",
      });
      expect(handler.mock.calls[0]?.[1]).toBe(stubCtx);
    });
  });
});
