import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import type { PluginHookBeforePromptBuildResult } from "./types.js";

const event = { prompt: "test", messages: [] };
const context = TEST_PLUGIN_AGENT_CTX;

describe("model and prompt hook wiring", () => {
  it("continues model resolution after a broken hook and propagates event and context", async () => {
    const handler = vi.fn(() => ({
      modelOverride: "demo-local-model",
      providerOverride: "demo-local-provider",
    }));
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "before_model_resolve",
          pluginId: "broken-plugin",
          priority: 10,
          handler: () => {
            throw new Error("plugin crashed");
          },
        },
        { hookName: "before_model_resolve", pluginId: "router-plugin", handler },
      ],
      { catchErrors: true },
    );
    const modelEvent = { prompt: "PII data" };
    const result = await runner.runBeforeModelResolve(modelEvent, context);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(modelEvent, context);
    expect(result).toEqual({
      modelOverride: "demo-local-model",
      providerOverride: "demo-local-provider",
    });
  });

  it("passes prompt and messages to context hooks", async () => {
    const handler = vi.fn(() => ({ prependContext: "context" }));
    const { runner } = createHookRunnerWithRegistry([{ hookName: "before_prompt_build", handler }]);
    const promptEvent = { prompt: "test", messages: [{}, {}] };
    const result = await runner.runBeforePromptBuild(promptEvent, context);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(promptEvent, context);
    expect(result?.prependContext).toBe("context");
  });

  it("skips timed-out handlers and continues", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const { runner } = createHookRunnerWithRegistry(
        [
          {
            hookName: "before_prompt_build",
            pluginId: "slow-plugin",
            priority: 10,
            handler: () => new Promise<PluginHookBeforePromptBuildResult>(() => {}),
          },
          {
            hookName: "before_prompt_build",
            pluginId: "fast-plugin",
            priority: 1,
            handler: () => ({ prependContext: "fast" }),
          },
        ],
        { logger, modifyingHookTimeoutMsByHook: { before_prompt_build: 5 } },
      );
      const result = runner.runBeforePromptBuild(event, context);
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toEqual({ prependContext: "fast" });
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] before_prompt_build handler from slow-plugin failed: timed out after 5ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors per-hook registration timeouts over the default modifying hook timeout", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const { runner } = createHookRunnerWithRegistry(
        [
          {
            hookName: "before_prompt_build",
            pluginId: "active-memory",
            priority: 10,
            timeoutMs: 30,
            handler: async () => {
              await new Promise((resolve) => {
                setTimeout(resolve, 20);
              });
              return { prependContext: "memory context" };
            },
          },
        ],
        { logger, modifyingHookTimeoutMsByHook: { before_prompt_build: 5 } },
      );
      const result = runner.runBeforePromptBuild(event, context);
      await vi.advanceTimersByTimeAsync(20);
      await expect(result).resolves.toEqual({ prependContext: "memory context" });
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
