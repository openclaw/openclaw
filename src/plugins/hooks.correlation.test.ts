import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

function timedHook(
  hookName: "before_compaction" | "after_compaction" | "agent_end",
  pluginId: string,
  handler: () => Promise<void>,
  timeoutMs?: number,
) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const runner = createHookRunner(
    createMockPluginRegistry([{ hookName, pluginId, handler, timeoutMs }]),
    { logger },
  );
  return { runner, logger };
}

function heldHook(reject = false) {
  const finish = createDeferredCore();
  const finished = createDeferredCore();
  const state = { calls: 0, settled: false };
  const { runner, logger } = timedHook(
    "before_compaction",
    "held-hook",
    async () => {
      state.calls++;
      try {
        await finish.promise;
        if (reject) {
          throw new Error("fixture late hook failure");
        }
      } finally {
        state.settled = true;
        finished.resolve();
      }
    },
    5,
  );
  return {
    finish,
    finished,
    state,
    logger,
    run: () => runner.runBeforeCompaction({ messageCount: 3 }, TEST_PLUGIN_AGENT_CTX),
  };
}

describe("hook timeouts", () => {
  it("keeps one-shot agent_end runs alive until a ref'd timeout fires", () => {
    const hooksUrl = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.hooks);
    const script = `
      import { createHookRunner } from ${JSON.stringify(hooksUrl.href)};
      const runner = createHookRunner({ typedHooks: [{
        pluginId: "plugin-a", hookName: "agent_end", source: "test",
        handler: () => new Promise(() => {}),
      }] }, {
        logger: { error: console.error, warn: console.warn },
        voidHookTimeoutMsByHook: { agent_end: 20 },
      });
      await runner.runAgentEnd({ messages: [], success: true },
        { runId: "test-run-id" }, { unrefTimeout: false });
      console.log("settled-after-timeout");
    `;
    const child = spawnSync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(hooksUrl).slice(0, -1), "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toContain(
      "[hooks] agent_end handler from plugin-a failed: timed out after 20ms",
    );
    expect(child.stdout).toContain("settled-after-timeout");
  });

  it.each([
    ["agent_end", Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
    ["after_compaction", undefined, 30_000],
  ] as const)("bounds the %s timeout", async (hookName, timeoutMs, delay) => {
    vi.useFakeTimers();
    const hung = hookName === "after_compaction";
    const { runner, logger } = timedHook(
      hookName,
      "plugin-a",
      () => (hung ? new Promise<void>(() => {}) : Promise.resolve()),
      timeoutMs,
    );
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const run = hung
        ? runner.runAfterCompaction({ messageCount: 2, compactedCount: 1 }, TEST_PLUGIN_AGENT_CTX)
        : runner.runAgentEnd({ messages: [], success: true }, TEST_PLUGIN_AGENT_CTX);
      if (hung) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      await expect(run).resolves.toBeUndefined();
      expect(timer).toHaveBeenCalledWith(expect.any(Function), delay);
      if (hung) {
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] after_compaction handler from plugin-a failed: timed out after 30000ms",
        );
      }
    } finally {
      timer.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("timed hook work", () => {
  it.each(["open", "closing"] as const)(
    "joins a raw handler after its timeout with an %s owner",
    async (phase) => {
      const owner = new AsyncWorkScope();
      const { finish, state, logger, run } = heldHook();
      let drain: Promise<void> | undefined;
      try {
        if (phase === "closing") {
          owner.beginClose();
        }
        await owner.run(run);
        expect(state.settled).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          "[hooks] before_compaction handler from held-hook failed: timed out after 5ms",
        );
        let drained = false;
        drain = owner.drain().then(() => {
          drained = true;
        });
        await nextTurn();
        expect(drained).toBe(false);
        finish.resolve();
        await drain;
        expect(state.settled).toBe(true);
      } finally {
        finish.resolve();
        await (drain ?? owner.drain());
      }
    },
  );

  it.each([
    { phase: "closed", outcome: "success" },
    { phase: "raw", outcome: "late rejection" },
    { phase: "closed", outcome: "late rejection" },
  ] as const)("preserves $phase hook reporting through $outcome", async ({ phase, outcome }) => {
    const owner = new AsyncWorkScope();
    const context = owner.run(() => AsyncLocalStorage.snapshot());
    await owner.drain();
    const { finish, finished, state, logger, run } = heldHook(outcome === "late rejection");
    const result = phase === "closed" ? context(run) : run();
    try {
      expect(state.calls).toBe(1);
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
      await finished.promise;
      await result;
    }
  });
});
