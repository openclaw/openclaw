import { spawnSync } from "node:child_process";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createHookRunner } from "./hooks.js";
import {
  createHookRunnerWithRegistry,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-fixtures.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

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

  it.each(["before_compaction", "after_compaction"] as const)(
    "bounds a hung %s hook with its default timeout",
    async (hookName) => {
      vi.useFakeTimers();
      try {
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
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(run).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(
          `[hooks] ${hookName} handler from plugin-a failed: timed out after 30000ms`,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
