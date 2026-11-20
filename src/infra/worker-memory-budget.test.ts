import { getEnvironmentData } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { GatewayResourceProfile } from "./gateway-resource-profile.js";
import {
  createWorkerMemoryBudget,
  getWorkerMemoryBudgetSnapshot,
  initializeWorkerMemoryBudget,
} from "./worker-memory-budget.js";

const MiB = 1024 ** 2;
const transcriptUrl = new URL("file:///runtime/session-transcript.worker.js");

function setup(options: {
  usageMiB: number;
  baselineMiB?: number;
  live?: { pools?: Map<number, number>; direct?: Map<string, number> };
  hosted?: (url: string, key?: string) => boolean;
}) {
  const pools = new Map<object, number>();
  let usage = options.usageMiB * MiB;
  const live = {
    pools: options.live?.pools ?? new Map<number, number>(),
    direct: options.live?.direct ?? new Map<string, number>(),
  };
  const budget = createWorkerMemoryBudget({
    // 1000 MiB limit -> 850 MiB budget.
    limitBytes: 1000 * MiB,
    readUsageBytes: () => usage,
    baselineBytes: (options.baselineMiB ?? 0) * MiB,
    usageSource: "cgroup-v2-working-set",
    countLive: () => live,
    poolId: (pool) => {
      if (!pools.has(pool)) {
        pools.set(pool, pools.size + 1);
      }
      return pools.get(pool)!;
    },
    hosted: () => options.hosted ?? (() => false),
  });
  return {
    budget,
    live,
    setUsage: (mib: number) => {
      usage = mib * MiB;
    },
  };
}

describe("worker memory budget", () => {
  it("admits growth only while usage, pending reservations and the estimate fit", () => {
    // Transcript estimate 38 MiB; its unstarted floor is pending: 700 + 38 + 38 < 850.
    const { budget, setUsage } = setup({ usageMiB: 700 });
    const pool = budget.registerPool({}, transcriptUrl, 2);
    expect(pool.floor).toBe(1);
    expect(pool.admitGrowth()).toBe(true);
    // The admitted growth is pending as well: 760 + 38 + 38 + 38 >= 850.
    setUsage(760);
    expect(pool.admitGrowth()).toBe(false);
    pool.releaseGrowth(1);
    expect(pool.admitGrowth()).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      budgetBytes: 850 * MiB,
      growthAdmissions: 2,
      refusals: 1,
      floorBytes: 38 * MiB,
    });
  });

  it("charges running workers through measured usage, not twice", () => {
    const owner = {};
    const { budget, live } = setup({ usageMiB: 790 });
    const pool = budget.registerPool(owner, transcriptUrl, 2);
    // Floor not yet running: 790 + 38 + 38 >= 850.
    expect(pool.admitGrowth()).toBe(false);
    live.pools.set(1, 1);
    expect(budget.snapshot().pendingBytes).toBe(0);
    expect(pool.admitGrowth()).toBe(true);
  });

  it("reserves settlement capacity for shared-state reads and the point-read lane once used", () => {
    const { budget } = setup({ usageMiB: 0 });
    const reads = budget.registerPool(
      {},
      new URL("file:///runtime/openclaw-state-read.worker.js"),
      2,
    );
    expect(reads.floor).toBe(2);
    expect(budget.snapshot().floorBytes).toBe(2 * 37 * MiB);
    reads.reservePointReadFloor();
    expect(budget.snapshot().floorBytes).toBe(3 * 37 * MiB);
  });

  it.each([
    [true, 0],
    [false, 38 * MiB],
  ])(
    "charges a floor slot only when the shared host does not claim it (claimed=%s)",
    (claimed, bytes) => {
      const { budget } = setup({
        usageMiB: 0,
        hosted: (url) => claimed && url === transcriptUrl.href,
      });
      budget.registerPool({}, transcriptUrl, 2);
      expect(budget.snapshot()).toMatchObject({ floorBytes: bytes, pendingBytes: bytes });
    },
  );

  it("applies a hosted-slot predicate registered after the pool", () => {
    const options: Parameters<typeof setup>[0] = { usageMiB: 0 };
    const { budget } = setup(options);
    budget.registerPool({}, transcriptUrl, 2);
    expect(budget.snapshot().floorBytes).toBe(38 * MiB);
    options.hosted = (url) => url === transcriptUrl.href;
    expect(budget.snapshot().floorBytes).toBe(0);
  });

  it("reserves direct family floors once seen, minus carriers the shared host claims", () => {
    const direct = new Map([["sqlite-store.worker.js", 1]]);
    const unhosted = setup({ usageMiB: 0, live: { direct } }).budget.snapshot();
    // Two agent carriers plus shared state, one running.
    expect(unhosted).toMatchObject({ floorBytes: 3 * 61 * MiB, pendingBytes: 2 * 61 * MiB });
    const hosted = setup({ usageMiB: 0, live: { direct }, hosted: () => true }).budget.snapshot();
    expect(hosted).toMatchObject({ floorBytes: 61 * MiB, pendingBytes: 0 });
  });

  it("reports floors that alone exceed the budget and then admits no growth", () => {
    const { budget } = setup({ usageMiB: 100 });
    const growing = budget.registerPool({}, transcriptUrl, 4);
    for (let index = 0; index < 20; index++) {
      budget.registerPool({}, new URL(`file:///runtime/plugin-${index}.worker.js`), 2);
    }
    expect(budget.snapshot().floorsExceedBudget).toBe(true);
    expect(growing.admitGrowth()).toBe(false);
  });

  it("records waits by family", () => {
    const { budget } = setup({ usageMiB: 0 });
    const pool = budget.registerPool({}, transcriptUrl, 2);
    pool.waitStarted();
    expect(budget.snapshot()).toMatchObject({ waits: 1, waitingTasks: 1 });
    pool.waitFinished(250);
    expect(budget.snapshot().families).toEqual([
      expect.objectContaining({
        family: "session-transcript.worker.js",
        waits: 1,
        waitingTasks: 0,
        waitMs: 250,
        maxWaitMs: 250,
      }),
    ]);
  });

  it("drops a closed pool's reservations", () => {
    const owner = {};
    const { budget } = setup({ usageMiB: 0 });
    budget.registerPool(owner, transcriptUrl, 2).reservePointReadFloor();
    expect(budget.snapshot().floorBytes).toBe(2 * 38 * MiB);
    budget.releasePool(owner);
    expect(budget.snapshot()).toMatchObject({ floorBytes: 0, pendingBytes: 0 });
  });

  it("refuses growth while floors alone exceed the budget, even when they measure small", () => {
    const owners = Array.from({ length: 15 }, () => ({}));
    const live = new Map(owners.map((_, index) => [index + 1, 1]));
    const { budget } = setup({ usageMiB: 500, live: { pools: live } });
    const pools = owners.map((owner, index) =>
      budget.registerPool(owner, new URL(`file:///runtime/plugin-${index}.worker.js`), 2),
    );
    // 15 x 62 MiB floors > 850 MiB budget, all running, and nothing pending.
    expect(budget.snapshot()).toMatchObject({ floorsExceedBudget: true, pendingBytes: 0 });
    expect(pools[0]!.admitGrowth()).toBe(false);
  });

  it("ignores late growth release after its pool was released", () => {
    const owner = {};
    const { budget } = setup({ usageMiB: 0 });
    const pool = budget.registerPool(owner, transcriptUrl, 2);
    expect(pool.admitGrowth()).toBe(true);
    budget.releasePool(owner);
    expect(pool.isCurrent()).toBe(false);
    pool.releaseGrowth(1);
    expect(budget.snapshot().families[0]!.growth).toBe(0);
  });

  it("retires the previous Gateway's policy and inherited flag when standard is selected", () => {
    const profile = (selected: "lean" | "standard"): GatewayResourceProfile => ({
      configured: selected,
      profile: selected,
      reason: "explicit",
      memoryLimitBytes: 1536 * MiB,
      memoryLimitSource: "host",
      cpus: 8,
    });
    initializeWorkerMemoryBudget(profile("lean"));
    expect(getEnvironmentData("openclaw.workerMemoryBudget.floorOnly")).toBe(true);
    expect(getWorkerMemoryBudgetSnapshot()?.budgetBytes).toBe(Math.floor(1536 * MiB * 0.85));
    initializeWorkerMemoryBudget(profile("standard"));
    expect(getEnvironmentData("openclaw.workerMemoryBudget.floorOnly")).toBeUndefined();
    expect(getWorkerMemoryBudgetSnapshot()).toBeUndefined();
  });

  it("counts the measured startup baseline with the floors", () => {
    // 700 MiB baseline + one 38 MiB transcript floor + 150 MiB of unmeasured kinds > 850 MiB.
    const { budget } = setup({ usageMiB: 0, baselineMiB: 700 });
    budget.registerPool({}, transcriptUrl, 2);
    expect(budget.snapshot()).toMatchObject({
      baselineBytes: 700 * MiB,
      floorsExceedBudget: false,
    });
    budget.registerPool({}, new URL("file:///runtime/plugin-a.worker.js"), 2);
    budget.registerPool({}, new URL("file:///runtime/plugin-b.worker.js"), 2);
    expect(budget.snapshot().floorsExceedBudget).toBe(true);
  });

  it("reports when measured use at floors alone exceeds the budget", () => {
    const { budget } = setup({ usageMiB: 900 });
    const pool = budget.registerPool({}, transcriptUrl, 2);
    expect(budget.snapshot().floorsExceedBudget).toBe(false);
    expect(pool.admitGrowth()).toBe(false);
    expect(budget.snapshot().floorsExceedBudget).toBe(true);
  });
});
