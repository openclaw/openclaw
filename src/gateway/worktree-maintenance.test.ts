import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { WorktreeGcProgress } from "../agents/worktrees/gc-progress.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import {
  getRuntimeConfigSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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

function maintenanceFixture(config: OpenClawConfig = {}) {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const params = {
    scheduler,
    getRuntimeConfig: () => config,
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
  return { clock, ...params, start: () => startWorktreeMaintenance(params) };
}

function holdGc(repeat = false) {
  const entered = createDeferred<NonNullable<Parameters<typeof managedWorktrees.gc>[0]>>();
  const release = createDeferred<ManagedWorktreeGcResult>();
  const implementation = (params: NonNullable<Parameters<typeof managedWorktrees.gc>[0]> = {}) => {
    entered.resolve(params);
    return release.promise;
  };
  const gc = vi.spyOn(managedWorktrees, "gc");
  if (repeat) {
    gc.mockImplementation(implementation);
  } else {
    gc.mockImplementationOnce(implementation).mockResolvedValue(completedResult());
  }
  return { entered, release, gc };
}

function awaitCleanup<T>(entered: Promise<T>, running: Promise<void> | void) {
  return awaitGateBeforeSettlement(entered, Promise.resolve(running), "cleanup never started");
}

afterEach(() => {
  resetConfigRuntimeState();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("worktree maintenance owner", () => {
  it("coalesces archive notifications into cleanup under the maintenance context", async () => {
    const { clock, scheduler, getRuntimeConfig, start } = maintenanceFixture();
    const context = new AsyncLocalStorage<string>();
    const observed: Array<string | undefined> = [];
    const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation(async () => {
      observed.push(context.getStore());
      return completedResult();
    });
    const owner = context.run("maintenance", start);
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
    const { clock, scheduler, getRuntimeConfig, start } = maintenanceFixture();
    const { entered, release, gc } = holdGc();
    const owner = start();
    notifyGatewayWorktreeArchive(getRuntimeConfig);
    const running = clock.advanceBy(0);
    try {
      await awaitCleanup(entered.promise, running);
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
      const { clock, scheduler, getRuntimeConfig, onComplete, onError, start } =
        maintenanceFixture();
      const paused = createDeferred();
      const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params = {}) => {
        const progress = completedResult();
        for (let index = 1; index <= batchSize + 1; index++) {
          progress.protectedCount = index;
          progress.gitMaintenance = {
            repoRoot: "/synthetic/project",
            stage: "packs",
            packsBefore: 8800,
            packsAfter: 7777,
          };
          progress.packsRemoved = 1023;
          if (index === batchSize) {
            clock.setTime(elapsedMs);
            paused.resolve();
          }
          await params.checkpoint!(progress);
        }
        return progress;
      });
      const owner = start();
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
          gitMaintenance: {
            repoRoot: "/synthetic/project",
            stage: "packs",
            packsBefore: 8800,
            packsAfter: 7777,
          },
          packsRemoved: 1023,
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
        completed.gitMaintenance!.packsAfter = 0;
        expect(owner.request({ jobId: receipt.jobId }).gitMaintenance?.packsAfter).toBe(7777);
        expect(owner.request({ jobId: receipt.jobId }).removed).toEqual([]);
      } finally {
        await owner.stop();
        await running;
        await scheduler.stop();
      }
    },
  );

  it("waits for admitted cleanup to settle when stopped and withdraws its authority immediately", async () => {
    const { clock, scheduler, getRuntimeConfig, onComplete, onError, start } = maintenanceFixture();
    const { entered, release } = holdGc(true);
    const owner = start();
    owner.request();
    const running = clock.advanceBy(0);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      const guard = await awaitCleanup(entered.promise, running);
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
    const { clock, scheduler, getRuntimeConfig, onComplete, start } = maintenanceFixture();
    const { entered, release, gc } = holdGc();
    const first = start();
    first.request();
    const oldRun = clock.advanceBy(0);
    let successor: ReturnType<typeof startWorktreeMaintenance> | undefined;
    let newRun: Promise<void> | void = undefined;
    try {
      await awaitCleanup(entered.promise, oldRun);
      successor = start();
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

  it.each<[string, OpenClawConfig, boolean?, boolean?]>([
    ["UI sidebar preferences", { ui: { prefs: { sidebarEntries: ["sessions"] } } }, false],
    ["logging", { logging: { level: "debug" } }, false],
    ["worktree capacity", { worktreeMaxCount: 8_192 }],
    ["worktree root", { worktreeRoot: "/tmp/other-worktrees" }],
    ["session store", { session: { store: "/tmp/other-sessions.db" } }],
    ["session alias", { session: { mainKey: "other" } }],
    ["session scope", { session: { scope: "global" } }],
    ["agent workspace", { agents: { entries: { main: { workspace: "/tmp/other-workspace" } } } }],
    [
      "default sandbox mode",
      { agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } } },
    ],
    ["agent model", { agents: { entries: { main: { model: "openai/gpt-5" } } } }, false],
    ["agent roster", { agents: { entries: { main: {}, other: {} } } }],
    ["agent sandbox mode", { agents: { entries: { main: { sandbox: { mode: "all" } } } } }],
    [
      "default workspace",
      { agents: { defaults: { workspace: "/tmp/other-workspace" }, entries: { main: {} } } },
    ],
    [
      "fixed session store owner",
      { agents: { defaults: { sessionStore: { agentId: "other" } }, entries: { main: {} } } },
    ],
    ["ACP session store roster", { acp: { allowedAgents: ["other"] } }],
    ["same-object worktree capacity", { worktreeMaxCount: 8_192 }, true, true],
  ])(
    "handles a %s publication during cleanup",
    async (_name, change, cancels = true, inPlace = false) => {
      const { clock, scheduler, onComplete } = maintenanceFixture();
      const { entered, release } = holdGc(true);
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const owner = startWorktreeMaintenance({
        scheduler,
        getRuntimeConfig: () => getRuntimeConfigSnapshot()!,
        onComplete,
        onError: vi.fn(),
      });
      const receipt = owner.request();
      const running = clock.advanceBy(0);
      try {
        const guard = await awaitCleanup(entered.promise, running);
        setRuntimeConfigSnapshot(
          inPlace ? Object.assign(config, change) : { ...config, ...change },
        );
        if (cancels) {
          expect(() => guard.commitGuard!()).toThrow(/configuration changed/);
        } else {
          guard.commitGuard!();
          await guard.checkpoint!(completedResult());
        }
        release.resolve(completedResult());
        await running;
        expect(owner.request({ jobId: receipt.jobId })).toMatchObject(
          cancels
            ? { state: "failed", error: expect.stringContaining("configuration changed") }
            : { state: "completed", error: null },
        );
        expect(onComplete).toHaveBeenCalledTimes(cancels ? 0 : 1);
      } finally {
        release.resolve(completedResult());
        await owner.stop();
        await running;
        await scheduler.stop();
      }
    },
  );
});
