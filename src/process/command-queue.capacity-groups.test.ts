import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane as enqueue,
  getCommandLaneSnapshot as snapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency as setConcurrency,
} from "./command-queue.js";
import { CommandLane } from "./lanes.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";
const MOVED_GROUP = "cron-delivery";
type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];

function configure(
  budget: number,
  reservations?: LaneGroupSpec["reservations"],
  members = [CRON, HOOK],
) {
  publish(budget, undefined, reservations, members);
}
function publish(
  budget: number,
  lanes?: Record<string, number>,
  reservations?: LaneGroupSpec["reservations"],
  members = [CRON, HOOK],
) {
  publishLaneConfiguration({ lanes, groups: { [GROUP]: { budget, members, reservations } } });
}
function clearGroups() {
  publishLaneConfiguration({ clearGroups: [GROUP, MOVED_GROUP] });
}
function park(
  lane: string,
  priority?: "foreground" | "background",
  onStart?: () => void,
  onFinish?: () => void,
) {
  const gate = createDeferred();
  const cancellation = new AbortController();
  const run = enqueue(
    lane,
    async () => {
      onStart?.();
      await gate.promise;
      onFinish?.();
    },
    { priority, abortSignal: cancellation.signal },
  );
  return { run, resolve: gate.resolve, cancel: () => cancellation.abort() };
}
async function releaseAll(tasks: ReturnType<typeof park>[], cancelPending = false) {
  tasks.forEach((task) => task.resolve());
  if (cancelPending) {
    tasks.forEach((task) => task.cancel());
  }
  const runs = tasks.map(({ run }) => run);
  await (cancelPending ? Promise.allSettled(runs) : Promise.all(runs));
}
function expectCounts(lane: string, activeCount: number, queuedCount: number) {
  expect(snapshot(lane)).toMatchObject({ activeCount, queuedCount });
}
beforeEach(() => {
  resetAllLanes();
  clearGroups();
  for (const lane of [CRON, HOOK, DELIVERY]) {
    setConcurrency(lane, 8);
  }
});
afterEach(() => {
  vi.useRealTimers();
  clearGroups();
  resetAllLanes();
});

describe("command lane capacity groups", () => {
  test("a reserved lane starts under sibling saturation", async () => {
    configure(8, { [HOOK]: 1 });
    const cron = Array.from({ length: 7 }, () => park(CRON, "foreground"));
    expect(snapshot(CRON).activeCount).toBe(7);
    const waiting: string[] = [];
    const extra = createDeferred();
    const blockedCron = enqueue(CRON, async () => await extra.promise, {
      priority: "foreground",
      onQueued: () => waiting.push(CRON),
    });
    expect(snapshot(CRON)).toMatchObject({
      activeCount: 7,
      blockedBy: "sibling-reservation",
    });
    const hookGate = createDeferred();
    const hookRun = enqueue(HOOK, () => hookGate.promise, {
      priority: "background",
      onQueued: () => waiting.push(HOOK),
    });
    expect(snapshot(HOOK)).toMatchObject({ activeCount: 1, groupActive: 8 });
    expect(waiting).toEqual([CRON]);
    hookGate.resolve();
    await hookRun;
    cron.forEach(({ resolve }) => resolve());
    extra.resolve();
    await Promise.all([...cron.map(({ run }) => run), blockedCron]);
  });

  test("a failing completion gives shared capacity to the older eligible sibling head", async () => {
    configure(2, { [HOOK]: 1 });
    const firstHookGate = createDeferred();
    const firstHook = enqueue(
      HOOK,
      async () => {
        await firstHookGate.promise;
        throw new Error("expected hook failure");
      },
      { priority: "background" },
    );
    const { run: secondHook, resolve: secondHookGate } = park(HOOK, "background");
    expect(snapshot(HOOK).activeCount).toBe(2);
    // The completing HOOK lane must not reclaim the slot ahead of older CRON work.
    const { run: cronRun, resolve: cronGate } = park(CRON, "background");
    const { run: thirdHook, resolve: thirdHookGate } = park(HOOK, "background");
    firstHookGate.resolve();
    await expect(firstHook).rejects.toThrow("expected hook failure");
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 1, 1);
    cronGate();
    secondHookGate();
    thirdHookGate();
    await Promise.all([cronRun, secondHook, thirdHook]);
  });

  test.each([
    ["foreground", 0, ["foreground", "background"]],
    ["normal", 14_999, ["normal", "background"]],
    ["normal", 15_000, ["background", "normal"]],
  ] as const)(
    "bounds %s overtaking across member lanes at %dms",
    async (priority, ageMs, expected) => {
      vi.useFakeTimers();
      configure(1);
      const { run: blocker, resolve: blockerGate } = park(HOOK);
      const order: string[] = [];
      const olderBackground = enqueue(CRON, async () => void order.push("background"), {
        priority: "background",
      });
      vi.advanceTimersByTime(ageMs);
      const newerPriority = enqueue(HOOK, async () => void order.push(priority), {
        priority,
      });
      expectCounts(HOOK, 1, 1);
      expectCounts(CRON, 0, 1);
      blockerGate();
      await Promise.all([blocker, olderBackground, newerPriority]);
      expect(order).toEqual(expected);
    },
  );

  test("aging applies across member lanes without borrowing a sibling reservation", async () => {
    vi.useFakeTimers();
    configure(2, { [HOOK]: 1 }, [HOOK, CRON]);
    const { run: blocker, resolve: blockerGate } = park(CRON);
    const order: string[] = [];
    const background = enqueue(CRON, async () => void order.push("background"), {
      priority: "background",
    });
    vi.advanceTimersByTime(30_000);
    expect(snapshot(CRON)).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
      blockedBy: "sibling-reservation",
    });
    const { run: hook, resolve: hookGate } = park(HOOK);
    const foreground = enqueue(HOOK, async () => void order.push("foreground"), {
      priority: "foreground",
    });
    blockerGate();
    await blocker;
    await Promise.all([background, foreground]);
    expect(order).toEqual(["background", "foreground"]);
    hookGate();
    await hook;
  });

  test("three-member arbitration is independent of member iteration order", async () => {
    configure(1, undefined, [CRON, HOOK, DELIVERY]);
    const { run: blocker, resolve: blockerGate } = park(CRON, "background");

    // DELIVERY queues first but is visited last; FIFO must win over iteration order.
    const { run: olderDelivery, resolve: deliveryGate } = park(DELIVERY, "background");
    const { run: newerHook, resolve: hookGate } = park(HOOK, "background");
    blockerGate();
    await blocker;
    expectCounts(DELIVERY, 1, 0);
    expectCounts(HOOK, 0, 1);
    deliveryGate();
    await olderDelivery;
    hookGate();
    await newerHook;
  });

  test("multi-slot restart re-arbitrates before stale completions arrive", async () => {
    configure(2);
    const staleHooks = Array.from({ length: 2 }, () => park(HOOK, "background"));
    const { run: cronRun, resolve: cronGate } = park(CRON, "background");
    const queuedHooks = Array.from({ length: 2 }, () => park(HOOK, "background"));
    resetAllLanes();
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 1, 1);
    expect(snapshot(HOOK).groupActive).toBe(2);

    // Stale completions must neither retire new task IDs nor admit the queued hook.
    staleHooks.forEach(({ resolve }) => resolve());
    await Promise.all(staleHooks.map(({ run }) => run));
    expect(snapshot(CRON).activeCount).toBe(1);
    expectCounts(HOOK, 1, 1);
    cronGate();
    queuedHooks[0]!.resolve();
    await Promise.all([cronRun, queuedHooks[0]!.run]);
    queuedHooks[1]!.resolve();
    await queuedHooks[1]!.run;
  });

  test("resetAllLanes refills a group by queue order rather than lane order", async () => {
    configure(1, undefined, [HOOK, CRON]);
    const { run: staleHook, resolve: staleGate } = park(HOOK, "background");
    const { run: olderCron, resolve: cronGate } = park(CRON, "background");
    const { run: newerHook, resolve: hookGate } = park(HOOK, "background");
    resetAllLanes();
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 0, 1);
    staleGate();
    await staleHook;
    expect(snapshot(CRON).activeCount).toBe(1);
    expect(snapshot(HOOK).queuedCount).toBe(1);
    cronGate();
    await olderCron;
    hookGate();
    await newerHook;
  });

  test("commits a slot before an onWait callback can re-enter the group", async () => {
    setConcurrency(CRON, 0);
    setConcurrency(HOOK, 1);
    const cronGate = createDeferred();
    const cronStarted = createDeferred();
    const hookGate = createDeferred();
    let hookRun: Promise<void> | undefined;
    let active = 0;
    let peak = 0;
    const cronRun = enqueue(
      CRON,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        cronStarted.resolve();
        await cronGate.promise;
        active -= 1;
      },
      {
        priority: "background",
        warnAfterMs: 0,
        onWait: () => {
          hookRun = enqueue(
            HOOK,
            async () => {
              active += 1;
              peak = Math.max(peak, active);
              await hookGate.promise;
              active -= 1;
            },
            { priority: "foreground" },
          );
        },
      },
    );
    publishLaneConfiguration({
      lanes: { [CRON]: 1 },
      groups: { [GROUP]: { budget: 1, members: [CRON, HOOK] } },
    });
    await withTestTimeout(
      cronStarted.promise,
      1_000,
      "cron task did not start after capacity-group publication",
    );
    expect(hookRun).toBeDefined();
    expect(peak).toBe(1);
    expect(snapshot(CRON).activeCount).toBe(1);
    expectCounts(HOOK, 0, 1);
    cronGate.resolve();
    await cronRun;
    expect(snapshot(HOOK).activeCount).toBe(1);
    hookGate.resolve();
    await hookRun;
    expect(peak).toBe(1);
  });

  test("rejects lanes that can be synchronously awaited", () => {
    // `cron` awaits `cron-nested`; grouping them turns a wait into a deadlock.
    for (const lane of [
      "cron",
      "session:probe-setup-inference:openai",
      "subagent:agent:main:parent",
      "main",
      CommandLane.SystemAgent,
    ]) {
      expect(() => configure(2, undefined, [lane, HOOK])).toThrow(/cannot join a capacity group/);
    }
    expect(() => configure(2, undefined, [CommandLane.SystemAgentInference, HOOK])).not.toThrow();
  });

  test("rejects a reservation for a non-member lane", () => {
    expect(() => configure(2, { [HOOK]: 1 }, [CRON])).toThrow(/reserves for non-member lane/);
  });
});

describe("publishLaneConfiguration", () => {
  test("no member dispatches above budget DURING publication", async () => {
    // A per-lane drain before group installation would admit 8 + 4 tasks.
    setConcurrency(CRON, 0);
    setConcurrency(HOOK, 0);
    let active = 0;
    let peak = 0;
    const publishedStarts = createDeferred();
    const tasks = [CRON, HOOK].flatMap((lane, index) =>
      Array.from({ length: index === 0 ? 12 : 6 }, () =>
        park(
          lane,
          undefined,
          () => {
            active += 1;
            peak = Math.max(peak, active);
            if (active >= 8) {
              publishedStarts.resolve();
            }
          },
          () => {
            active -= 1;
          },
        ),
      ),
    );
    expect(active).toBe(0); // nothing may run before publication
    expect(snapshot(CRON).activeCount).toBe(0);
    expect(snapshot(HOOK).activeCount).toBe(0);
    try {
      publish(8, { [CRON]: 8, [HOOK]: 4 }, { [HOOK]: 1 });
      await withTestTimeout(
        publishedStarts.promise,
        1_000,
        "publication did not start the shared group budget",
      );
      expect(peak).toBe(8);
    } finally {
      await releaseAll(tasks, true);
    }
  });

  test("commit dispatch uses group order rather than publication object order", async () => {
    setConcurrency(CRON, 0);
    setConcurrency(HOOK, 0);
    const starts: string[] = [];
    const cronStarted = createDeferred();
    const hookStarted = createDeferred();
    const start = (lane: string, signal: { resolve: () => void }) =>
      park(lane, "background", () => {
        starts.push(lane);
        signal.resolve();
      });
    const cron = start(CRON, cronStarted);
    const hook = start(HOOK, hookStarted);
    try {
      // HOOK is published first; the older CRON head must still win.
      publish(1, { [HOOK]: 1, [CRON]: 1 }, undefined, [HOOK, CRON]);
      await withTestTimeout(
        cronStarted.promise,
        1_000,
        "publication did not start the older cron task",
      );
      expect(starts).toEqual([CRON]);
      cron.resolve();
      await cron.run;
      await withTestTimeout(
        hookStarted.promise,
        1_000,
        "cron completion did not start the queued hook",
      );
      expect(starts).toEqual([CRON, HOOK]);
    } finally {
      await releaseAll([cron, hook], true);
    }
  });

  test("moving a busy member wakes queued work in its previous group", async () => {
    publish(1, { [CRON]: 1, [HOOK]: 1, [DELIVERY]: 1 });
    const cronGate = park(CRON);
    const hookGate = park(HOOK);
    expect(snapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });
    // Moving active CRON work must immediately free its old group for HOOK.
    publishLaneConfiguration({
      groups: { [MOVED_GROUP]: { budget: 1, members: [CRON, DELIVERY] } },
    });
    expect(snapshot(HOOK)).toMatchObject({
      group: GROUP,
      activeCount: 1,
      queuedCount: 0,
    });
    expect(snapshot(CRON).group).toBe(MOVED_GROUP);
    cronGate.resolve();
    hookGate.resolve();
    await Promise.all([cronGate.run, hookGate.run]);
  });

  test("a rejected configuration does not leave lane maxima mutated", async () => {
    // Reject before mutating: a later enqueue must not dispatch the preserved queue.
    setConcurrency(CRON, 0);
    const tasks = Array.from({ length: 4 }, () => park(CRON));
    expect(snapshot(CRON).maxConcurrent).toBe(0);
    expect(() => publish(2, { [CRON]: 8 }, { [CRON]: 2, [HOOK]: 1 })).toThrow(
      /reserves 3 slots but its budget is 2/,
    );
    expect(snapshot(CRON).maxConcurrent).toBe(0);
    expect(snapshot(CRON).group).toBeUndefined();
    const extra = park(CRON);
    expect(snapshot(CRON).activeCount).toBe(0);
    await releaseAll([...tasks, extra], true);
  });

  test("a rejected replacement does not tear down the existing group first", async () => {
    // Validate before clearing the old group or changing its members' widths.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    expect(snapshot(CRON).group).toBe(GROUP);

    expect(() =>
      publishLaneConfiguration({
        lanes: { [CRON]: 99 },
        clearGroups: [GROUP],
        groups: {
          "replacement-group": {
            budget: 1,
            members: [CRON, HOOK],
            reservations: { [CRON]: 1, [HOOK]: 1 },
          },
        },
      }),
    ).toThrow(/reserves 2 slots but its budget is 1/);

    expect(snapshot(CRON).group).toBe(GROUP);
    expect(snapshot(CRON).groupBudget).toBe(8);
    expect(snapshot(CRON).maxConcurrent).toBe(8);
    expect(snapshot(HOOK).reservedForLane).toBe(1);
  });

  test("publication wakes members when a replacement frees capacity", async () => {
    // Budget expansion must wake queued work without another enqueue.
    setConcurrency(CRON, 8);
    setConcurrency(HOOK, 1);
    publish(2);
    const tasks = Array.from({ length: 5 }, () => park(CRON));
    expect(snapshot(CRON)).toMatchObject({ activeCount: 2, queuedCount: 3 });
    publish(5);
    expect(snapshot(CRON)).toMatchObject({ activeCount: 5, queuedCount: 0 });
    await releaseAll(tasks);
  });

  test("republishing a narrower budget does not admit beyond the new cap", async () => {
    publish(8, { [CRON]: 8, [HOOK]: 1 }, { [HOOK]: 1 });
    const tasks = Array.from({ length: 3 }, () => park(CRON));
    expect(snapshot(CRON).activeCount).toBe(3);
    // Narrowing cannot evict running work or admit more while over budget.
    publish(2, { [CRON]: 8, [HOOK]: 1 }, { [HOOK]: 1 });
    const extra = park(CRON);
    expect(snapshot(CRON).activeCount).toBe(3);
    expect(snapshot(CRON).blockedBy).toBe("group-budget");
    await releaseAll([...tasks, extra], true);
  });
});
