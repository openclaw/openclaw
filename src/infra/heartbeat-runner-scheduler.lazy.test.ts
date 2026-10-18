import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { runHeartbeatOnce } from "./heartbeat-runner-run.js";
import type { HeartbeatRunner } from "./heartbeat-runner-scheduler.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

function config(heartbeat: { every: string; prompt?: string }): OpenClawConfig {
  return { agents: { entries: { main: {} }, defaults: { heartbeat } } };
}
const cfg = config({ every: "30m" });
const runners: HeartbeatRunner[] = [];
const executionLoaded = vi.fn();
const execute = vi.fn<typeof runHeartbeatOnce>();
const manualWake = { source: "manual", intent: "manual", agentId: "main" } as const;
let loading = createDeferredCore();
let release = createDeferredCore();

beforeEach(() => {
  // Cold module evaluation is the contract under test, not shared scheduler state.
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  executionLoaded.mockClear();
  execute.mockReset().mockResolvedValue({ status: "ran", durationMs: 1 });
  loading = createDeferredCore();
  release = createDeferredCore();
  vi.doMock("./heartbeat-runner-run.js", async () => {
    executionLoaded();
    loading.resolve();
    await release.promise;
    return { runHeartbeatOnce: execute };
  });
});

afterEach(async () => {
  await releaseExecution();
  for (const runner of runners.splice(0)) {
    runner.stop();
  }
  const { setHeartbeatWakeHandler } = await import("./heartbeat-wake.js");
  const disabled = { status: "skipped", reason: "disabled" } as const;
  const dispose = setHeartbeatWakeHandler(async () => disabled);
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
      requestHeartbeatAndWait({ ...manualWake, ...overrides, coalesceMs: 0 }),
  };
}

async function waitForExecution() {
  await vi.advanceTimersByTimeAsync(1);
  expect(execute).not.toHaveBeenCalled();
  await loading.promise;
}

async function releaseExecution() {
  release.resolve();
  await vi.dynamicImportSettled();
}

async function expectRan(result: Promise<unknown>) {
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ status: "ran" });
}

describe("heartbeat scheduler execution loading", { concurrent: false }, () => {
  it("keeps execution unloaded through synchronous start, update, and stop", async () => {
    vi.doMock("./heartbeat-runner-config.js", () => {
      throw new Error("execution configuration loaded by the scheduler factory");
    });
    const { start } = await loadScheduler();
    const runner = start();
    expect([runner.updateConfig(cfg), runner.stop()]).toEqual([undefined, undefined]);
    expect(executionLoaded).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["interval", "manual"] as const)(
    "keeps the %s wake configuration captured before loading execution",
    async (source) => {
      const { start, wake } = await loadScheduler();
      const runner = start();
      expect(executionLoaded).not.toHaveBeenCalled();
      const nextHeartbeat = { every: "5m", prompt: "updated heartbeat" };
      const nextCfg = config(nextHeartbeat);
      const intent = source === "interval" ? "scheduled" : "manual";
      const result = wake({ source, intent, reason: source });
      await waitForExecution();
      runner.updateConfig(nextCfg);
      await releaseExecution();
      await expect(result).resolves.toMatchObject({ status: "ran" });
      expect(executionLoaded).toHaveBeenCalledOnce();
      const firstRun = { cfg, agentId: "main", heartbeat: { every: "30m" }, source, intent };
      expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(firstRun));
      await expectRan(wake());
      expect(execute).toHaveBeenCalledTimes(2);
      const heartbeat = { every: "5m", prompt: "updated heartbeat" };
      expect(execute).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cfg: nextCfg, heartbeat }),
      );
    },
  );

  it.each(["stop", "abort", "replace"] as const)(
    "settles the loading wake without duplicate execution after %s",
    async (action) => {
      const { start, wake } = await loadScheduler();
      const owner = new AbortController();
      const original = start({ cfg, abortSignal: owner.signal });
      const replacement = vi
        .fn<typeof runHeartbeatOnce>()
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      const result = wake();
      await waitForExecution();
      if (action === "stop") {
        original.stop();
      } else if (action === "abort") {
        owner.abort();
      }
      if (action !== "replace") {
        await expect(result).resolves.toEqual({
          status: "skipped",
          reason: "handler-unavailable",
        });
      }
      start({ cfg, runOnce: replacement });
      await vi.advanceTimersByTimeAsync(250);
      expect(replacement).not.toHaveBeenCalled();

      await releaseExecution();
      await vi.advanceTimersByTimeAsync(1);

      if (action === "replace") {
        await expect(result).resolves.toMatchObject({ status: "ran" });
        expect(execute).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
        await expectRan(wake());
      } else {
        expect(execute).not.toHaveBeenCalled();
        const { HEARTBEAT_IDLE_RETRY_GRACE_MS } = await import("./heartbeat-wake.js");
        await vi.advanceTimersByTimeAsync(HEARTBEAT_IDLE_RETRY_GRACE_MS);
      }
      expect(replacement).toHaveBeenCalledOnce();
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
