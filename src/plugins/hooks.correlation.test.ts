import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

function timedHook(
  hookName: "before_compaction" | "after_compaction",
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
  let child: { status: number | null; stderr: string; stdout: string };
  beforeAll(() => {
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
    child = spawnSync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(hooksUrl).slice(0, -1), "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
  });

  it("keeps one-shot agent_end runs alive until a ref'd timeout fires", () => {
    expect(child.status).toBe(0);
    expect(child.stderr).toContain(
      "[hooks] agent_end handler from plugin-a failed: timed out after 20ms",
    );
    expect(child.stdout).toContain("settled-after-timeout");
  });

  it("clamps oversized registration timeouts before scheduling", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "agent_end", handler: async () => {}, timeoutMs: Number.MAX_SAFE_INTEGER },
      ]),
    );
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await runner.runAgentEnd({ messages: [], success: true }, TEST_PLUGIN_AGENT_CTX);
      expect(timer).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timer.mockRestore();
    }
  });

  it("bounds a hung after_compaction hook with its default timeout", async () => {
    vi.useFakeTimers();
    try {
      const { runner, logger } = timedHook(
        "after_compaction",
        "plugin-a",
        () => new Promise<void>(() => {}),
      );
      const run = runner.runAfterCompaction(
        { messageCount: 2, compactedCount: 1 },
        TEST_PLUGIN_AGENT_CTX,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] after_compaction handler from plugin-a failed: timed out after 30000ms",
      );
    } finally {
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
