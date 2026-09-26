// Compaction hooks run on a serialized notification queue; a hung handler must release it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const DEFAULT_COMPACTION_HOOK_TIMEOUT_MS = 30_000;

describe("compaction hook default timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["before_compaction", "after_compaction"] as const)(
    "bounds a never-settling %s handler with the default timeout",
    async (hookName) => {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const { runner } = createHookRunnerWithRegistry(
        [{ hookName, pluginId: "plugin-a", handler: () => new Promise<void>(() => {}) }],
        { logger },
      );
      const run =
        hookName === "before_compaction"
          ? runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX)
          : runner.runAfterCompaction(
              { messageCount: 2, compactedCount: 1 },
              TEST_PLUGIN_AGENT_CTX,
            );

      await vi.advanceTimersByTimeAsync(DEFAULT_COMPACTION_HOOK_TIMEOUT_MS);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] ${hookName} handler from plugin-a failed: timed out after ${DEFAULT_COMPACTION_HOOK_TIMEOUT_MS}ms`,
      );
    },
  );

  it("lets a fast before_compaction handler complete without timing out", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "before_compaction",
          pluginId: "plugin-a",
          handler: () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            }),
        },
      ],
      { logger },
    );
    const run = runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX);

    await vi.advanceTimersByTimeAsync(20);

    await expect(run).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
