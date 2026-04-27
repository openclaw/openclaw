import { describe, it, expect, vi } from "vitest";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import { createHookRunner } from "./hooks.js";

function createTestRegistry(
  hooks: Array<{
    pluginId: string;
    hookName: string;
    handler: (event: unknown, ctx: unknown) => unknown;
  }>,
) {
  return {
    hooks,
    typedHooks: hooks.map((h) => ({
      pluginId: h.pluginId,
      hookName: h.hookName as any,
      handler: h.handler,
      priority: 0,
      source: "test",
    })),
    channelPlugins: [],
    providerPlugins: [],
    getPluginConfig: () => undefined,
  } as unknown as GlobalHookRunnerRegistry;
}

describe("resolve_exec_env hook", () => {
  it("returns empty object when no hooks registered", async () => {
    const runner = createHookRunner(createTestRegistry([]), { catchErrors: true });
    const result = await runner.runResolveExecEnv(
      { sessionKey: "test", toolName: "exec", host: "gateway" },
      { sessionKey: "test" },
    );
    expect(result).toEqual({});
  });

  it("merges env vars from a single plugin", async () => {
    const handler = vi.fn().mockResolvedValue({ FEISHU_APP_ID: "cli_123", FEISHU_USER_ID: "u456" });
    const runner = createHookRunner(
      createTestRegistry([{ pluginId: "feishu", hookName: "resolve_exec_env", handler }]),
      { catchErrors: true },
    );
    const result = await runner.runResolveExecEnv(
      { sessionKey: "test", toolName: "exec", host: "gateway" },
      { sessionKey: "test" },
    );
    expect(result).toEqual({ FEISHU_APP_ID: "cli_123", FEISHU_USER_ID: "u456" });
    expect(handler).toHaveBeenCalledWith(
      { sessionKey: "test", toolName: "exec", host: "gateway" },
      { sessionKey: "test" },
    );
  });

  it("merges env vars from multiple plugins, later overrides earlier", async () => {
    const handler1 = vi.fn().mockResolvedValue({ A: "1", B: "2" });
    const handler2 = vi.fn().mockResolvedValue({ B: "3", C: "4" });
    const runner = createHookRunner(
      createTestRegistry([
        { pluginId: "plugin-a", hookName: "resolve_exec_env", handler: handler1 },
        { pluginId: "plugin-b", hookName: "resolve_exec_env", handler: handler2 },
      ]),
      { catchErrors: true },
    );
    const result = await runner.runResolveExecEnv({ sessionKey: "test", toolName: "exec" }, {});
    expect(result).toEqual({ A: "1", B: "3", C: "4" });
  });

  it("handles async handlers", async () => {
    const handler = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ASYNC_KEY: "value" };
    });
    const runner = createHookRunner(
      createTestRegistry([{ pluginId: "async-plugin", hookName: "resolve_exec_env", handler }]),
      { catchErrors: true },
    );
    const result = await runner.runResolveExecEnv({ sessionKey: "test", toolName: "exec" }, {});
    expect(result).toEqual({ ASYNC_KEY: "value" });
  });
});
