import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginHookResolveExecEnvContext } from "./types.js";

const ctx: PluginHookResolveExecEnvContext = {
  agentId: "agent-1",
  sessionKey: "agent:agent-1:main",
  messageProvider: "telegram",
  channelId: "chat-1",
};

describe("resolve_exec_env hook", () => {
  it("returns an empty env when no handlers are registered", async () => {
    const runner = createHookRunner(createEmptyPluginRegistry());

    await expect(
      runner.runResolveExecEnv(
        { sessionKey: ctx.sessionKey, toolName: "exec", host: "gateway" },
        ctx,
      ),
    ).resolves.toEqual({});
  });

  it("merges env vars from multiple plugins in priority order", async () => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks<Record<string, string>>(registry, {
      hookName: "resolve_exec_env",
      hooks: [
        {
          pluginId: "first",
          priority: 100,
          result: { SHARED: "first", FIRST_ONLY: "1" },
        },
        {
          pluginId: "second",
          priority: 50,
          result: { SHARED: "second", SECOND_ONLY: "2" },
        },
      ],
    });
    const runner = createHookRunner(registry);

    await expect(
      runner.runResolveExecEnv(
        { sessionKey: ctx.sessionKey, toolName: "exec", host: "gateway" },
        ctx,
      ),
    ).resolves.toEqual({
      FIRST_ONLY: "1",
      SECOND_ONLY: "2",
      SHARED: "second",
    });
  });

  it("isolates handler errors so other plugins can still contribute env", async () => {
    const registry = createEmptyPluginRegistry();
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    addTestHook({
      registry,
      pluginId: "crasher",
      hookName: "resolve_exec_env",
      handler: async () => {
        throw new Error("plugin failed");
      },
      priority: 100,
    });
    addTestHook({
      registry,
      pluginId: "healthy",
      hookName: "resolve_exec_env",
      handler: async () => ({ HEALTHY_ENV: "ok" }),
      priority: 50,
    });

    const runner = createHookRunner(registry, { logger });

    await expect(
      runner.runResolveExecEnv(
        { sessionKey: ctx.sessionKey, toolName: "exec", host: "gateway" },
        ctx,
      ),
    ).resolves.toEqual({ HEALTHY_ENV: "ok" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("resolve_exec_env handler from crasher failed"),
    );
  });
});
