import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { WorktreeGcProgress } from "../agents/worktrees/gc-progress.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { WorktreeWarmPoolRequest } from "../agents/worktrees/template-registry.js";
import type { ManagedWorktreeGcResult, ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import {
  getRuntimeConfigSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as hostIoPressure from "../infra/host-io-pressure.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { prepareScratchMaintenanceTargets } from "./scratch-maintenance-custody.js";
import {
  notifyGatewayWorktreeArchive,
  requestGatewayWorktreeMaintenance,
  startWorktreeMaintenance,
} from "./worktree-maintenance.js";

// mock-isolation: Scheduler fixtures have no shared-state broker; CAS sweep behavior has worker tests.
vi.mock("./worker-environments/local-workspace-gc.js", () => ({
  sweepLocalWorkspaceManifests: vi.fn(async () => {}),
}));

// mock-isolation: Run custody has its own integration suite; these fixtures own scheduling.
vi.mock("./scratch-maintenance-custody.js", () => ({
  prepareScratchMaintenanceTargets: vi.fn(async () => ({ targets: [], release: () => {} })),
}));

const cleanupRecord: ManagedWorktreeRecord = {
  id: "worktree",
  name: "expired",
  repoFingerprint: "repository",
  repoRoot: "/repository",
  path: "/worktree",
  branch: "expired",
  baseRef: "main",
  ownerKind: "session",
  ownerId: "agent:main:expired",
  createdAt: 1,
  lastActiveAt: 1,
};

function completedResult(): ManagedWorktreeGcResult {
  return { ...new WorktreeGcProgress().result, limitsSatisfied: true };
}

it("expires disposable scratch on the existing maintenance pass and records the outcome", async () => {
  const dirs = createTrackedTempDirs();
  try {
    const root = await fs.realpath(await dirs.make("worktree-maintenance-scratch-"));
    const scratch = path.join(root, ".openclaw/tmp/proof.txt");
    await fs.mkdir(path.dirname(scratch), { recursive: true });
    await fs.writeFile(scratch, "proof");
    await fs.utimes(scratch, 1, 1);
    vi.mocked(prepareScratchMaintenanceTargets).mockResolvedValueOnce({
      targets: [{ root, kind: "checkout", isLive: () => false }],
      release: () => {},
    });
    vi.spyOn(managedWorktrees, "gc").mockResolvedValue(completedResult());
    await using fixture = maintenanceFixture();
    fixture.clock.setTime(1_800_000_000_000);
    const owner = fixture.start();
    const receipt = owner.request();
    await fixture.run();
    expect(owner.request({ jobId: receipt.jobId })).toMatchObject({
      state: "completed",
      scratch: { entriesRemoved: 1, bytesRemoved: 5, skippedLive: 0, errors: [] },
    });
    await expect(fs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await dirs.cleanup();
  }
});

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

function warmPoolDemand() {
  let notify: (request: WorktreeWarmPoolRequest) => void = () => {};
  const unregister = vi.fn();
  vi.spyOn(managedWorktrees, "onWarmPoolNeeded").mockImplementation((listener) => {
    notify = listener;
    return unregister;
  });
  return {
    unregister,
    notify(cacheKey: string, sourceCommit = cacheKey) {
      notify({
        sourceOnly: true,
        template: {
          cacheKey,
          sourceCommit,
          id: cacheKey,
          repoRoot: "/synthetic/repo",
          commonDir: "/synthetic/repo/.git",
          worktreeRoot: "/synthetic/worktrees",
          path: `/synthetic/worktrees/.templates/${cacheKey}`,
          backend: "btrfs",
          contentKey: sourceCommit,
          status: "ready",
          createdAt: 1,
          lastUsedAt: 1,
        },
      });
    },
  };
}

beforeEach(() => {
  vi.spyOn(hostIoPressure, "createHostIoPressureProbe").mockReturnValue(async () => false);
});

afterEach(() => {
  resetConfigRuntimeState();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

it("refills serially in maintenance context, coalescing bounded latest repository demand", async () => {
  await using fixture = maintenanceFixture();
  const demand = warmPoolDemand();
  const context = new AsyncLocalStorage<string>();
  const observed: Array<[string, string | undefined]> = [];
  const entered = createDeferred();
  const release = createDeferred();
  vi.spyOn(managedWorktrees, "prewarm").mockImplementation(async (request) => {
    observed.push([request.template.sourceCommit, context.getStore()]);
    if (observed.length === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  context.run("maintenance", () => fixture.start());
  context.run("request", () => {
    for (let index = 0; index < 33; index++) {
      demand.notify(String(index));
    }
    demand.notify("0", "latest");
  });
  const running = fixture.run();
  try {
    await awaitCleanup(entered.promise, running);
    expect(observed).toEqual([["latest", "maintenance"]]);
    demand.notify("0", "consumed-again");
  } finally {
    release.resolve();
  }
  await running;
  expect(observed).toEqual([
    ["latest", "maintenance"],
    ...Array.from({ length: 31 }, (_, index) => [String(index + 1), "maintenance"]),
    ["consumed-again", "maintenance"],
  ]);
  expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("queue is full"));
});

it.each(["stop", "configuration"])("withdraws refill authority on %s", async (change) => {
  const config: OpenClawConfig = {};
  await using fixture = maintenanceFixture(config);
  const demand = warmPoolDemand();
  const entered = createDeferred<Parameters<typeof managedWorktrees.prewarm>[1]>();
  const release = createDeferred();
  const prewarm = vi
    .spyOn(managedWorktrees, "prewarm")
    .mockImplementation(async (_request, guard) => {
      entered.resolve(guard);
      await release.promise;
      guard.commitGuard?.();
    });
  const owner = fixture.start();
  demand.notify("first");
  const running = fixture.run();
  const guard = await awaitCleanup(entered.promise, running);
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    if (change === "stop") {
      stopping = owner.stop().then(() => {
        stopped = true;
      });
      fixture.track(stopping);
      expect(guard.signal?.aborted).toBe(true);
      expect(demand.unregister).toHaveBeenCalledOnce();
    } else {
      config.worktreeAcceleration = false;
    }
    demand.notify("second");
    expect(() => guard.commitGuard?.()).toThrow(/stopping|configuration changed/);
    await Promise.resolve();
    expect(stopped).toBe(false);
  } finally {
    release.resolve();
  }
  await running;
  await stopping;
  expect(prewarm).toHaveBeenCalledOnce();
  expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("refill failed"));
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

it("admits only one checkout or template removal per minute across cohorts and sweeps", async () => {
  await using fixture = maintenanceFixture();
  const removed: number[] = [];
  vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params = {}) => {
    const progress = completedResult();
    for (let index = 0; index < 3; index++) {
      if (index === 1) {
        await params.beforeTemplateRemoval?.();
      } else {
        await params.beforeRemoval?.(cleanupRecord);
      }
      removed.push(fixture.clock.clock.now());
      progress.removed.push(String(index));
      await params.checkpoint?.(progress);
    }
    return progress;
  });
  const owner = fixture.start();
  owner.request();
  void fixture.run();
  await vi.waitFor(() => expect(removed).toHaveLength(1));
  await fixture.clock.advanceBy(59_999);
  expect(removed).toEqual([0]);
  await fixture.clock.advanceBy(1);
  await vi.waitFor(() => expect(removed).toHaveLength(2));
  await fixture.clock.advanceBy(60_000);
  await vi.waitFor(() => expect(fixture.onComplete).toHaveBeenCalledOnce());
  expect(removed).toEqual([0, 60_000, 120_000]);
  owner.request();
  void fixture.run();
  await fixture.clock.advanceBy(59_999);
  expect(removed).toHaveLength(3);
  await fixture.clock.advanceBy(1);
  await vi.waitFor(() => expect(removed).toHaveLength(4));
});

it.each([
  ["checkout", "recover"],
  ["checkout", "stop"],
  ["checkout", "configuration"],
  ["template", "recover"],
  ["template", "stop"],
  ["template", "configuration"],
])("pauses %s removal under host pressure and handles %s", async (kind, outcome) => {
  const probe = vi.fn().mockResolvedValue(true);
  vi.spyOn(hostIoPressure, "createHostIoPressureProbe").mockReturnValue(probe);
  const config: OpenClawConfig = {};
  await using fixture = maintenanceFixture(config);
  const removed = vi.fn();
  vi.spyOn(managedWorktrees, "gc").mockImplementation(async (params = {}) => {
    if (kind === "template") {
      await params.beforeTemplateRemoval!();
    } else {
      await params.beforeRemoval!(cleanupRecord);
    }
    removed();
    return completedResult();
  });
  const owner = fixture.start();
  owner.request();
  void fixture.run();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
  await fixture.clock.advanceBy(299_999);
  expect(removed).not.toHaveBeenCalled();
  if (outcome === "stop") {
    await owner.stop();
  } else {
    probe.mockResolvedValue(false);
    if (outcome === "configuration") {
      config.worktreeRoot = "/synthetic/replaced";
      setRuntimeConfigSnapshot(config);
    }
    await fixture.clock.advanceBy(1);
    await vi.waitFor(() =>
      expect(outcome === "recover" ? fixture.onComplete : fixture.onError).toHaveBeenCalledOnce(),
    );
  }
  expect(removed).toHaveBeenCalledTimes(outcome === "recover" ? 1 : 0);
});

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
