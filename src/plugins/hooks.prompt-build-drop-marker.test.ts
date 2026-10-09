import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import type { PluginHookBeforePromptBuildResult } from "./types.js";

const promptEvent = { prompt: "test", messages: [] };
const MARKER_OPEN = '<dropped_plugin_context hook="before_prompt_build">';

function createLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("before_prompt_build dropped-contribution marker", () => {
  it("skips timed-out handlers, continues, and marks the dropped contribution", async () => {
    vi.useFakeTimers();
    try {
      const logger = createLogger();
      const runner = createHookRunner(
        createMockPluginRegistry([
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
        ]),
        { logger, modifyingHookTimeoutMsByHook: { before_prompt_build: 5 } },
      );

      const resultPromise = runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(5);

      const result = await resultPromise;
      expect(result?.prependContext).toBe("fast");
      // Absence alone reads to the agent as "the plugin had nothing to say".
      expect(result?.appendContext).toContain(MARKER_OPEN);
      expect(result?.appendContext).toContain("slow-plugin (handler-failed)");
      expect(result?.appendContext).not.toContain("fast-plugin");
      expect(result?.appendContext).not.toContain("timed out after 5ms");
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] before_prompt_build handler from slow-plugin failed: timed out after 5ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps secret-like thrown error text out of the marker and only in the log", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    const logger = createLogger();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "leaky-plugin",
          handler: () => {
            throw new Error(`bd ready failed: ${secret}`);
          },
        },
        {
          hookName: "before_prompt_build",
          pluginId: "healthy-plugin",
          handler: () => ({ prependContext: "healthy" }),
        },
      ]),
      { logger },
    );

    const result = await runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);

    expect(result?.prependContext).toBe("healthy");
    expect(result?.appendContext).toContain("leaky-plugin (handler-failed)");
    expect(result?.appendContext).not.toContain(secret);
    expect(result?.appendContext).not.toContain("sk-live-9f3c");
    expect(result?.appendContext).not.toContain("internal.example");
    expect(result?.appendContext).not.toContain("bd ready failed");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("leaky-plugin failed: bd ready failed:"),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("AUTH_TOKEN=***"));
  });

  it("marks the skipped chain when a nested prompt build re-enters the dispatch", async () => {
    const logger = createLogger();
    let nested: PluginHookBeforePromptBuildResult | undefined;
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "authority-only-plugin",
          requiresToolAuthority: true,
          handler: () => ({ prependContext: "authorized" }),
        },
        {
          hookName: "before_prompt_build",
          pluginId: "nesting-plugin",
          handler: async () => {
            nested = await runner.runBeforePromptBuild(
              { prompt: "nested", messages: [] },
              TEST_PLUGIN_AGENT_CTX,
            );
            return { prependContext: "outer" };
          },
        },
      ]),
      { logger },
    );

    const outer = await runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);

    expect(outer?.prependContext).toBe("outer");
    expect(outer?.appendContext).toBeUndefined();
    expect(nested?.appendContext).toContain("nesting-plugin (nested-prompt-build)");
    expect(nested?.appendContext).not.toContain("authority-only-plugin");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[hooks] before_prompt_build skipped for a nested prompt build"),
    );
  });

  it("caps the marker when a nested prompt build skips many registered hooks", async () => {
    let nested: PluginHookBeforePromptBuildResult | undefined;
    const bulk = Array.from({ length: 30 }, (_, index) => ({
      hookName: "before_prompt_build",
      pluginId: `bulk-plugin-${index}`,
      handler: () => ({}),
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        ...bulk,
        {
          hookName: "before_prompt_build",
          pluginId: "nesting-plugin",
          handler: async () => {
            nested = await runner.runBeforePromptBuild(
              { prompt: "nested", messages: [] },
              TEST_PLUGIN_AGENT_CTX,
            );
            return {};
          },
        },
      ]),
      { logger: createLogger() },
    );

    await runner.runBeforePromptBuild(promptEvent, TEST_PLUGIN_AGENT_CTX);

    const marker = nested?.appendContext ?? "";
    expect(marker).toContain(MARKER_OPEN);
    expect(marker.match(/\(nested-prompt-build\)/gu)).toHaveLength(5);
    expect(marker).toContain("+26 more");
    expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
  });
});
