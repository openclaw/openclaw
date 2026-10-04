import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { WorktreeGcProgress } from "../agents/worktrees/gc-progress.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  notifyGatewayWorktreeArchive,
  requestGatewayWorktreeMaintenance,
  startWorktreeMaintenance,
} from "./worktree-maintenance.js";

function completedResult(): ManagedWorktreeGcResult {
  return { ...new WorktreeGcProgress().result, limitsSatisfied: true };
}

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("worktree maintenance owner", () => {
  it("coalesces archive notifications into cleanup under the maintenance context", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const context = new AsyncLocalStorage<string>();
    const observed: Array<string | undefined> = [];
    const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation(async () => {
      observed.push(context.getStore());
      return completedResult();
    });
    const config: OpenClawConfig = {};
    const getRuntimeConfig = () => config;
    const owner = context.run("maintenance", () =>
      startWorktreeMaintenance({
        scheduler,
        getRuntimeConfig,
        onComplete: vi.fn(),
        onError: vi.fn(),
      }),
    );
    try {
      context.run("archive-request", () => {
        notifyGatewayWorktreeArchive(getRuntimeConfig);
        notifyGatewayWorktreeArchive(getRuntimeConfig);
      });
      expect(gc).not.toHaveBeenCalled();
      await context.run("host-wake", () => clock.advanceBy(0));
      expect(observed).toEqual(["maintenance"]);
    } finally {
      await owner.stop();
      await scheduler.stop();
    }
  });

  it("sweeps again after archive commits during cleanup without overlapping passes", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferred();
    const release = createDeferred<ManagedWorktreeGcResult>();
    const gc = vi
      .spyOn(managedWorktrees, "gc")
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      })
      .mockResolvedValue(completedResult());
    const config: OpenClawConfig = {};
    const getRuntimeConfig = () => config;
    const owner = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig,
      onComplete: vi.fn(),
      onError: vi.fn(),
    });
    notifyGatewayWorktreeArchive(getRuntimeConfig);
    const running = clock.advanceBy(0);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        Promise.resolve(running),
        "cleanup never started",
      );
      notifyGatewayWorktreeArchive(getRuntimeConfig);
      notifyGatewayWorktreeArchive(getRuntimeConfig);
      await clock.advanceBy(0);
      expect(gc).toHaveBeenCalledOnce();
      release.resolve(completedResult());
      await running;
      await clock.advanceBy(0);
      expect(gc).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(completedResult());
      await owner.stop();
      await running;
      await scheduler.stop();
    }
  });

  it.each([
    { budget: "eight checkouts", batchSize: 8, elapsedMs: 0 },
    { budget: "five seconds", batchSize: 1, elapsedMs: 5_000 },
  ])(
    "yields after $budget while coalescing requests and publishing progress",
    async ({ batchSize, elapsedMs }) => {
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const config: OpenClawConfig = {};
      const getRuntimeConfig = () => config;
      const paused = createDeferred();
      const onComplete = vi.fn();
      const onError = vi.fn();
      const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params = {}) => {
        const progress = completedResult();
        for (let index = 1; index <= batchSize + 1; index++) {
          progress.protectedCount = index;
          if (index === batchSize) {
            clock.setTime(elapsedMs);
            paused.resolve();
          }
          await params.checkpoint!(progress);
        }
        return progress;
      });
      const owner = startWorktreeMaintenance({ scheduler, getRuntimeConfig, onComplete, onError });
      const receipt = requestGatewayWorktreeMaintenance(getRuntimeConfig, { retryDeferred: true });
      expect(owner.request()).toEqual(receipt);
      const running = clock.advanceBy(0);
      try {
        await awaitGateBeforeSettlement(
          paused.promise,
          Promise.resolve(running),
          "cleanup never reached its batch boundary",
        );
        expect(owner.request({ jobId: receipt.jobId })).toMatchObject({
          state: "running",
          protectedCount: batchSize,
        });
        expect(owner.request().jobId).toBe(receipt.jobId);
        expect(gc).toHaveBeenCalledOnce();
        expect(gc.mock.calls[0]?.[0]?.retryDeferred).toBe(true);
        await clock.advanceBy(999);
        expect(onComplete).not.toHaveBeenCalled();
        await clock.advanceBy(1);
        await running;
        const completed = owner.request({ jobId: receipt.jobId });
        expect(completed).toMatchObject({
          state: "completed",
          protectedCount: batchSize + 1,
          completedAt: elapsedMs + 1_000,
        });
        expect(onComplete).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        completed.removed.push("client-only");
        expect(owner.request({ jobId: receipt.jobId }).removed).toEqual([]);
      } finally {
        await owner.stop();
        await running;
        await scheduler.stop();
      }
    },
  );

  it("waits for admitted cleanup to settle when stopped and withdraws its authority immediately", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferred<NonNullable<Parameters<typeof managedWorktrees.gc>[0]>>();
    const release = createDeferred<ManagedWorktreeGcResult>();
    vi.spyOn(managedWorktrees, "gc").mockImplementation((params = {}) => {
      entered.resolve(params);
      return release.promise;
    });
    const config: OpenClawConfig = {};
    const getRuntimeConfig = () => config;
    const onComplete = vi.fn();
    const onError = vi.fn();
    const owner = startWorktreeMaintenance({ scheduler, getRuntimeConfig, onComplete, onError });
    owner.request();
    const running = clock.advanceBy(0);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      const guard = await awaitGateBeforeSettlement(
        entered.promise,
        Promise.resolve(running),
        "cleanup never started",
      );
      stopping = owner.stop().then(() => {
        stopped = true;
      });
      expect(guard.signal?.aborted).toBe(true);
      expect(() => guard.commitGuard!()).toThrow(/stopping/);
      expect(() => owner.request()).toThrow(/stopping/);
      notifyGatewayWorktreeArchive(getRuntimeConfig);
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve(completedResult());
      await stopping;
      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("stopping"));
      expect(() => requestGatewayWorktreeMaintenance(getRuntimeConfig)).toThrow(/not running/);
      notifyGatewayWorktreeArchive(getRuntimeConfig);
    } finally {
      release.resolve(completedResult());
      await owner.stop();
      await stopping;
      await running;
      await scheduler.stop();
    }
  });

  it("drains a replaced owner before its successor starts another sweep", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferred();
    const release = createDeferred<ManagedWorktreeGcResult>();
    const gc = vi
      .spyOn(managedWorktrees, "gc")
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      })
      .mockResolvedValue(completedResult());
    const config: OpenClawConfig = {};
    const getRuntimeConfig = () => config;
    const onComplete = vi.fn();
    const params = { scheduler, getRuntimeConfig, onComplete, onError: vi.fn() };
    const first = startWorktreeMaintenance(params);
    first.request();
    const oldRun = clock.advanceBy(0);
    let successor: ReturnType<typeof startWorktreeMaintenance> | undefined;
    let newRun: Promise<void> | void = undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        Promise.resolve(oldRun),
        "cleanup never started",
      );
      successor = startWorktreeMaintenance(params);
      const receipt = successor.request();
      newRun = clock.advanceBy(0);
      await Promise.resolve();
      expect(gc).toHaveBeenCalledOnce();
      expect(() => first.request()).toThrow(/stopping/);
      release.resolve(completedResult());
      await oldRun;
      await newRun;
      expect(gc).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledOnce();
      expect(
        requestGatewayWorktreeMaintenance(getRuntimeConfig, { jobId: receipt.jobId }),
      ).toMatchObject({ state: "completed" });
    } finally {
      release.resolve(completedResult());
      await first.stop();
      await successor?.stop();
      await oldRun;
      await newRun;
      await scheduler.stop();
    }
  });

  it("rejects a stale configuration at the mutation guard and records a failed receipt", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferred<NonNullable<Parameters<typeof managedWorktrees.gc>[0]>>();
    const release = createDeferred<ManagedWorktreeGcResult>();
    vi.spyOn(managedWorktrees, "gc").mockImplementation((params = {}) => {
      entered.resolve(params);
      return release.promise;
    });
    let config: OpenClawConfig = {};
    const onComplete = vi.fn();
    const owner = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig: () => config,
      onComplete,
      onError: vi.fn(),
    });
    const receipt = owner.request();
    const running = clock.advanceBy(0);
    try {
      const guard = await awaitGateBeforeSettlement(
        entered.promise,
        Promise.resolve(running),
        "cleanup never started",
      );
      config = { worktreeMaxCount: 8_192 };
      expect(() => guard.commitGuard!()).toThrow(/configuration changed/);
      release.resolve(completedResult());
      await running;
      expect(owner.request({ jobId: receipt.jobId })).toMatchObject({
        state: "failed",
        error: expect.stringContaining("configuration changed"),
      });
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      release.resolve(completedResult());
      await owner.stop();
      await running;
      await scheduler.stop();
    }
  });
});
