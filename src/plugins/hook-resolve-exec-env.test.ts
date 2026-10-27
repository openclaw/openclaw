import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHookRegistration } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

type EnvHandler = PluginHookRegistration<"resolve_exec_env">["handler"];
function setup(hooks: [string, EnvHandler, number][] = []) {
  const registry = createEmptyPluginRegistry();
  const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  for (const [pluginId, handler, priority] of hooks) {
    addTestHook({ registry, pluginId, handler, priority, hookName: "resolve_exec_env" });
  }
  const ctx = { sessionKey: "agent:agent-1:main" };
  return {
    logger,
    run: () =>
      createHookRunner(registry, { logger }).runResolveExecEnv(
        { sessionKey: ctx.sessionKey, toolName: "exec", host: "gateway" },
        ctx,
      ),
  };
}

describe("resolve_exec_env hook", () => {
  afterEach(() => vi.useRealTimers());

  it("returns an empty env when no handlers are registered", async () => {
    await expect(setup().run()).resolves.toEqual({});
  });

  it("merges env vars from multiple plugins in priority order", async () => {
    const { run } = setup([
      ["first", async () => ({ SHARED: "first", FIRST_ONLY: "1" }), 100],
      ["second", async () => ({ SHARED: "second", SECOND_ONLY: "2" }), 50],
    ]);
    await expect(run()).resolves.toEqual({ FIRST_ONLY: "1", SECOND_ONLY: "2", SHARED: "second" });
  });

  it.each(["error", "timeout"] as const)(
    "isolates a handler %s so healthy env survives",
    async (failure) => {
      if (failure === "timeout") {
        vi.useFakeTimers();
      }
      const pluginId = failure === "timeout" ? "hanging" : "crasher";
      const { run, logger } = setup([
        [
          pluginId,
          async () => {
            if (failure === "error") {
              throw new Error("plugin failed");
            }
            return new Promise<never>(() => {});
          },
          100,
        ],
        ["healthy", async () => ({ HEALTHY_ENV: "ok" }), 50],
      ]);
      const result = run();
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await expect(result).resolves.toEqual({ HEALTHY_ENV: "ok" });
      expect(logger.error).toHaveBeenCalledWith(
        failure === "timeout"
          ? "[hooks] resolve_exec_env handler from hanging failed: timed out after 15000ms"
          : expect.stringContaining("resolve_exec_env handler from crasher failed"),
      );
    },
  );
});
