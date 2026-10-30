import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
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

// mock-isolation: Scheduler fixtures have no shared-state broker; CAS sweep behavior has worker tests.
vi.mock("./worker-environments/local-workspace-gc.js", () => ({
  sweepLocalWorkspaceManifests: vi.fn(async () => {}),
}));

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
  const owners: ReturnType<typeof startWorktreeMaintenance>[] = [];
  const pending: Array<Promise<void> | void> = [];
  let release = () => {};
  return {
    clock,
    ...params,
    track: (work: Promise<void>) => pending.push(work),
    start: (overrides: Partial<typeof params> = {}) => {
      const owner = startWorktreeMaintenance({ ...params, ...overrides });
      owners.push(owner);
      return owner;
    },
    run() {
      const running = clock.advanceBy(0);
      pending.push(running);
      return running;
    },
    hold(repeat = false, onRun = () => {}) {
      const held = holdGc(repeat, onRun);
      release = () => held.release.resolve(completedResult());
      return held;
    },
    async runHeld(repeat = false, overrides: Partial<typeof params> = {}) {
      const held = this.hold(repeat);
      const owner = this.start(overrides);
      const receipt = owner.request();
      const running = this.run();
      const guard = await awaitCleanup(held.entered.promise, running);
      return { ...held, owner, receipt, running, guard };
    },
    async [Symbol.asyncDispose]() {
      release();
      for (const owner of owners) {
        await owner.stop();
      }
      for (const running of pending) {
        await running;
      }
      await scheduler.stop();
    },
  };
}

function holdGc(repeat = false, onRun = () => {}) {
  const entered = createDeferred<NonNullable<Parameters<typeof managedWorktrees.gc>[0]>>();
  const release = createDeferred<ManagedWorktreeGcResult>();
  const implementation = (params: NonNullable<Parameters<typeof managedWorktrees.gc>[0]> = {}) => {
    onRun();
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

it("coalesces archives in the maintenance context and sweeps again after in-flight commits", async () => {
  await using fixture = maintenanceFixture();
  const { clock, getRuntimeConfig, start } = fixture;
  const context = new AsyncLocalStorage<string>();
  const observed: Array<string | undefined> = [];
  const { entered, release, gc } = fixture.hold(false, () => {
    observed.push(context.getStore());
  });
  context.run("maintenance", start);
  context.run("archive-request", () => {
    notifyGatewayWorktreeArchive(getRuntimeConfig);
    notifyGatewayWorktreeArchive(getRuntimeConfig);
  });
  expect(gc).not.toHaveBeenCalled();
  const running = context.run("host-wake", () => fixture.run());
  await awaitCleanup(entered.promise, running);
  expect(observed).toEqual(["maintenance"]);
  notifyGatewayWorktreeArchive(getRuntimeConfig);
  notifyGatewayWorktreeArchive(getRuntimeConfig);
  await clock.advanceBy(0);
  expect(gc).toHaveBeenCalledOnce();
  release.resolve(completedResult());
  await running;
  await clock.advanceBy(0);
  expect(gc).toHaveBeenCalledTimes(2);
});

it.each([
  { budget: "eight checkouts", batchSize: 8, elapsedMs: 0 },
  { budget: "five seconds", batchSize: 1, elapsedMs: 5_000 },
])(
  "yields after $budget while coalescing requests and publishing progress",
  async ({ batchSize, elapsedMs }) => {
    await using fixture = maintenanceFixture();
    const { clock, getRuntimeConfig, onComplete, onError, start } = fixture;
    const paused = createDeferred();
    const gitMaintenance: NonNullable<ManagedWorktreeGcResult["gitMaintenance"]> = {
      repoRoot: "/synthetic/project",
      stage: "packs",
      packsBefore: 8800,
      packsAfter: 7777,
    };
    const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params = {}) => {
      const progress = completedResult();
      for (let index = 1; index <= batchSize + 1; index++) {
        progress.protectedCount = index;
        progress.gitMaintenance = { ...gitMaintenance };
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
    const running = fixture.run();
    await awaitGateBeforeSettlement(
      paused.promise,
      Promise.resolve(running),
      "cleanup never reached its batch boundary",
    );
    expect(owner.request({ jobId: receipt.jobId })).toMatchObject({
      state: "running",
      protectedCount: batchSize,
      gitMaintenance,
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
  },
);

it("waits for admitted cleanup to settle when stopped and withdraws its authority immediately", async () => {
  await using fixture = maintenanceFixture();
  const { getRuntimeConfig, onComplete, onError } = fixture;
  const { owner, guard, release } = await fixture.runHeld(true);
  let stopped = false;
  const stopping = owner.stop().then(() => {
    stopped = true;
  });
  fixture.track(stopping);
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
});

it("drains a replaced owner before its successor starts another sweep", async () => {
  await using fixture = maintenanceFixture();
  const { getRuntimeConfig, onComplete, start } = fixture;
  const { owner: first, running: oldRun, release, gc } = await fixture.runHeld();
  const successor = start();
  const receipt = successor.request();
  const newRun = fixture.run();
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
    await using fixture = maintenanceFixture();
    const { onComplete } = fixture;
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const { owner, receipt, running, guard, release } = await fixture.runHeld(true, {
      getRuntimeConfig: () => getRuntimeConfigSnapshot()!,
    });
    setRuntimeConfigSnapshot(inPlace ? Object.assign(config, change) : { ...config, ...change });
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
  },
);
