import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { runHeartbeatOnce } from "./heartbeat-runner-run.js";
import type { HeartbeatRunner } from "./heartbeat-runner-scheduler.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: { heartbeat: { every: "30m" } },
  },
};
const runners: HeartbeatRunner[] = [];
const executionLoaded = vi.fn();
const execute = vi.fn<typeof runHeartbeatOnce>();

beforeEach(() => {
  // Cold module evaluation is the contract under test, not shared scheduler state.
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  executionLoaded.mockClear();
  execute.mockReset().mockResolvedValue({ status: "ran", durationMs: 1 });
  vi.doMock("./heartbeat-runner-run.js", () => {
    executionLoaded();
    return { runHeartbeatOnce: execute };
  });
});

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    runner.stop();
  }
  const { setHeartbeatWakeHandler } = await import("./heartbeat-wake.js");
  const dispose = setHeartbeatWakeHandler(async () => ({
    status: "skipped",
    reason: "disabled",
  }));
  await vi.advanceTimersByTimeAsync(250);
  dispose();
  vi.doUnmock("./heartbeat-runner-run.js");
  vi.doUnmock("./heartbeat-runner-config.js");
  vi.useRealTimers();
});

async function loadScheduler() {
  const { startHeartbeatRunner } = await import("./heartbeat-runner-scheduler.js");
  const { requestHeartbeatAndWait } = await import("./heartbeat-wake.js");
  return {
    start: (options: Parameters<typeof startHeartbeatRunner>[0] = { cfg }) => {
      const runner = startHeartbeatRunner(options);
      runners.push(runner);
      return runner;
    },
    wake: (overrides: Partial<HeartbeatWakeRequest> = {}) =>
      requestHeartbeatAndWait({
        source: "manual",
        intent: "manual",
        agentId: "main",
        ...overrides,
        coalesceMs: 0,
      }),
  };
}

describe("heartbeat scheduler execution loading", { concurrent: false }, () => {
  it("keeps execution unloaded through synchronous start, update, and stop", async () => {
    const { start } = await loadScheduler();
    expect(executionLoaded).not.toHaveBeenCalled();

    const runner = start();
    expect(runner.updateConfig(cfg)).toBeUndefined();
    expect(runner.stop()).toBeUndefined();

    expect(executionLoaded).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps model, channel, and reply configuration outside the scheduler factory", async () => {
    vi.doMock("./heartbeat-runner-config.js", () => {
      throw new Error("execution configuration loaded by the scheduler factory");
    });
    const { start } = await loadScheduler();
    const runner = start({ cfg, runOnce: execute });
    runner.updateConfig(cfg);
    runner.stop();
    expect(executionLoaded).not.toHaveBeenCalled();
  });

  it("loads execution for the first wake and preserves its terminal result", async () => {
    const { start, wake } = await loadScheduler();
    start();
    expect(executionLoaded).not.toHaveBeenCalled();

    const result = wake();
    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();

    await expect(result).resolves.toMatchObject({ status: "ran" });
    expect(executionLoaded).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cfg,
        agentId: "main",
        heartbeat: { every: "30m" },
        source: "manual",
        intent: "manual",
      }),
    );
  });

  it.each(["interval", "manual"] as const)(
    "keeps the %s wake configuration captured before loading execution",
    async (source) => {
      const { start, wake } = await loadScheduler();
      const runner = start();
      const loading = createDeferredCore();
      const release = createDeferredCore();
      vi.doMock("./heartbeat-runner-run.js", async () => {
        loading.resolve();
        await release.promise;
        return { runHeartbeatOnce: execute };
      });
      const nextCfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { heartbeat: { every: "5m", prompt: "updated heartbeat" } },
        },
      };
      const result = wake({
        source,
        intent: source === "interval" ? "scheduled" : "manual",
        reason: source,
      });
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(execute).not.toHaveBeenCalled();
        await loading.promise;

        runner.updateConfig(nextCfg);
        release.resolve();
        await vi.dynamicImportSettled();
        await expect(result).resolves.toMatchObject({ status: "ran" });
        expect(execute).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            cfg,
            heartbeat: { every: "30m" },
          }),
        );

        const nextResult = wake();
        await vi.advanceTimersByTimeAsync(1);
        await expect(nextResult).resolves.toMatchObject({ status: "ran" });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            cfg: nextCfg,
            heartbeat: { every: "5m", prompt: "updated heartbeat" },
          }),
        );
      } finally {
        release.resolve();
        await vi.dynamicImportSettled();
      }
    },
  );

  it.each(["stop", "abort", "replace"] as const)(
    "does not dispatch the old wake after %s during execution loading",
    async (action) => {
      const { start, wake } = await loadScheduler();
      const owner = new AbortController();
      const original = start({ cfg, abortSignal: owner.signal });
      const loading = createDeferredCore();
      const release = createDeferredCore();
      vi.doMock("./heartbeat-runner-run.js", async () => {
        loading.resolve();
        await release.promise;
        return { runHeartbeatOnce: execute };
      });
      const replacement = vi
        .fn<typeof runHeartbeatOnce>()
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      const result = wake();
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(execute).not.toHaveBeenCalled();
        await loading.promise;

        if (action === "stop") {
          original.stop();
        } else if (action === "abort") {
          owner.abort();
        }
        start({ cfg, runOnce: replacement });
        await vi.advanceTimersByTimeAsync(250);
        await expect(result).resolves.toMatchObject({ status: "ran" });

        release.resolve();
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(1);

        expect(execute).not.toHaveBeenCalled();
        expect(replacement).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await vi.dynamicImportSettled();
      }
    },
  );

  it("returns a visible failure when loading execution rejects", async () => {
    const { start, wake } = await loadScheduler();
    start();
    vi.doMock("./heartbeat-runner-run.js", () => {
      throw new Error("heartbeat execution import failed");
    });

    const result = wake();
    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();

    await expect(result).resolves.toEqual({
      status: "failed",
      reason: expect.stringMatching(/\S/u),
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
