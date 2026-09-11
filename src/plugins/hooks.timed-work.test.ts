import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

describe("timed hook work", () => {
  it.each(["open", "closing"] as const)(
    "joins a raw handler after its timeout with an %s owner",
    async (phase) => {
      const owner = new AsyncWorkScope();
      const finish = createDeferredCore();
      let settled = false;
      const logger = { error: vi.fn(), warn: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            pluginId: "held-hook",
            hookName: "before_compaction",
            timeoutMs: 5,
            handler: async () => {
              await finish.promise;
              settled = true;
            },
          },
        ]),
        { logger },
      );
      let drain: Promise<void> | undefined;
      try {
        if (phase === "closing") {
          owner.beginClose();
        }
        await owner.run(() =>
          runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX),
        );
        expect(settled).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] before_compaction handler from held-hook failed: timed out after 5ms",
        );
        let drained = false;
        drain = owner.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(drained).toBe(false);
        finish.resolve();
        await drain;
        expect(settled).toBe(true);
      } finally {
        finish.resolve();
        await (drain ?? owner.drain());
      }
    },
  );

  it.each([
    { phase: "raw", outcome: "success" },
    { phase: "closed", outcome: "success" },
    { phase: "raw", outcome: "late rejection" },
    { phase: "closed", outcome: "late rejection" },
  ] as const)("preserves $phase hook reporting through $outcome", async ({ phase, outcome }) => {
    const owner = new AsyncWorkScope();
    const context = owner.run(() => AsyncLocalStorage.snapshot());
    await owner.drain();
    const finish = createDeferredCore();
    const settled = createDeferredCore();
    const failure = new Error("fixture late hook failure");
    let calls = 0;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          pluginId: "held-hook",
          hookName: "before_compaction",
          timeoutMs: 5,
          handler: async () => {
            calls++;
            try {
              await finish.promise;
              if (outcome === "late rejection") {
                throw failure;
              }
            } finally {
              settled.resolve();
            }
          },
        },
      ]),
      { logger },
    );
    const run = () => runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX);
    const result = phase === "closed" ? context(run) : run();
    try {
      expect(calls).toBe(1);
      if (outcome === "success") {
        finish.resolve();
      }
      await expect(result).resolves.toBeUndefined();
      if (outcome === "success") {
        expect(logger.error).not.toHaveBeenCalled();
      } else {
        expect(logger.error).toHaveBeenCalledOnce();
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] before_compaction handler from held-hook failed: timed out after 5ms",
        );
      }
    } finally {
      finish.resolve();
      await settled.promise;
      await result;
    }
  });
});
