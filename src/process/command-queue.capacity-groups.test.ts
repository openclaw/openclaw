// Capacity groups share a hard budget with non-borrowable member reservations.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import { CommandLane } from "./lanes.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";

type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];
type Reservations = LaneGroupSpec["reservations"];

function configure(budget: number, reservations?: Reservations, members = [CRON, HOOK]) {
  publishLaneConfiguration({ groups: { [GROUP]: { budget, members, reservations } } });
}

function clearCommandLaneGroup(group: string): void {
  publishLaneConfiguration({ clearGroups: [group] });
}

function park(lane: string, priority?: "foreground" | "background") {
  const gate = createDeferred();
  const run = enqueueCommandInLane(lane, () => gate.promise, { priority });
  return [run, gate.resolve] as const;
}

function expectCounts(lane: string, activeCount: number, queuedCount: number) {
  expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount, queuedCount });
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  setCommandLaneConcurrency(CRON, 8);
  setCommandLaneConcurrency(HOOK, 8);
  setCommandLaneConcurrency(DELIVERY, 8);
});

afterEach(() => {
  vi.useRealTimers();
  clearCommandLaneGroup(GROUP);
  resetAllLanes();
});

describe("command lane capacity groups", () => {
  test("a reserved lane starts under sibling saturation", async () => {
    configure(8, { [HOOK]: 1 });
    const gates = Array.from({ length: 7 }, () => createDeferred());
    const cronRuns = gates.map((g) =>
      enqueueCommandInLane(CRON, async () => await g.promise, { priority: "foreground" }),
    );
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);
    const waiting: string[] = [];
    const extra = createDeferred();
    const blockedCron = enqueueCommandInLane(CRON, async () => await extra.promise, {
      priority: "foreground",
      onQueued: () => waiting.push(CRON),
    });
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({
      activeCount: 7,
      blockedBy: "sibling-reservation",
    });
    const hookGate = createDeferred();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
      onQueued: () => waiting.push(HOOK),
    });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, groupActive: 8 });
    expect(waiting).toEqual([CRON]);
    hookGate.resolve();
    await hookRun;
    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    await Promise.all([...cronRuns, blockedCron]);
  });

  test("a failing completion gives shared capacity to the older eligible sibling head", async () => {
    configure(2, { [HOOK]: 1 });
    const firstHookGate = createDeferred();
    const firstHook = enqueueCommandInLane(
      HOOK,
      async () => {
        await firstHookGate.promise;
        throw new Error("expected hook failure");
      },
      { priority: "background" },
    );
    const [secondHook, secondHookGate] = park(HOOK, "background");
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(2);
    // The completing HOOK lane must not reclaim the slot ahead of older CRON work.
    const [cronRun, cronGate] = park(CRON, "background");
    const [thirdHook, thirdHookGate] = park(HOOK, "background");
    firstHookGate.resolve();
    await expect(firstHook).rejects.toThrow("expected hook failure");
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 1, 1);
    cronGate();
    secondHookGate();
    thirdHookGate();
    await Promise.all([cronRun, secondHook, thirdHook]);
  });

  test("priority outranks group-global enqueue sequence", async () => {
    configure(1);
    const [blocker, blockerGate] = park(HOOK);
    const [olderBackground, cronGate] = park(CRON, "background");
    const [newerForeground, hookGate] = park(HOOK, "foreground");
    blockerGate();
    await blocker;
    expectCounts(HOOK, 1, 0);
    expectCounts(CRON, 0, 1);
    hookGate();
    await newerForeground;
    cronGate();
    await olderBackground;
  });

  test("aging applies across member lanes without borrowing a sibling reservation", async () => {
    vi.useFakeTimers();
    configure(2, { [HOOK]: 1 }, [HOOK, CRON]);
    const [blocker, blockerGate] = park(CRON);
    const order: string[] = [];
    const background = enqueueCommandInLane(CRON, async () => void order.push("background"), {
      priority: "background",
    });
    vi.advanceTimersByTime(30_000);
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
      blockedBy: "sibling-reservation",
    });
    const [hook, hookGate] = park(HOOK);
    const foreground = enqueueCommandInLane(HOOK, async () => void order.push("foreground"), {
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
    const [blocker, blockerGate] = park(CRON, "background");

    // DELIVERY queues first but is visited last; FIFO must win over iteration order.
    const [olderDelivery, deliveryGate] = park(DELIVERY, "background");
    const [newerHook, hookGate] = park(HOOK, "background");
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
    const staleGates = [createDeferred(), createDeferred()];
    const staleHooks = staleGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );
    const [cronRun, cronGate] = park(CRON, "background");
    const queuedHookGates = [createDeferred(), createDeferred()];
    const queuedHooks = queuedHookGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );
    resetAllLanes();
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 1, 1);
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(2);

    // Stale completions must neither retire new task IDs nor admit the queued hook.
    for (const g of staleGates) {
      g.resolve();
    }
    await Promise.all(staleHooks);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expectCounts(HOOK, 1, 1);
    cronGate();
    queuedHookGates[0]?.resolve();
    await Promise.all([cronRun, queuedHooks[0]]);
    queuedHookGates[1]?.resolve();
    await queuedHooks[1];
  });

  test("resetAllLanes refills a group by queue order rather than lane order", async () => {
    configure(1, undefined, [HOOK, CRON]);
    const [staleHook, staleGate] = park(HOOK, "background");
    const [olderCron, cronGate] = park(CRON, "background");
    const [newerHook, hookGate] = park(HOOK, "background");
    resetAllLanes();
    expectCounts(CRON, 1, 0);
    expectCounts(HOOK, 0, 1);
    staleGate();
    await staleHook;
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).queuedCount).toBe(1);
    cronGate();
    await olderCron;
    hookGate();
    await newerHook;
  });

  test("commits a slot before an onWait callback can re-enter the group", async () => {
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 1);
    const cronGate = createDeferred();
    const cronStarted = createDeferred();
    const hookGate = createDeferred();
    let hookRun: Promise<void> | undefined;
    let active = 0;
    let peak = 0;
    const cronRun = enqueueCommandInLane(
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
          hookRun = enqueueCommandInLane(
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
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expectCounts(HOOK, 0, 1);
    cronGate.resolve();
    await cronRun;
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    hookGate.resolve();
    await hookRun;
    expect(peak).toBe(1);
  });

  test("a timed-out task releases group capacity to a queued sibling", async () => {
    configure(1);
    const timedOut = enqueueCommandInLane(CRON, async () => new Promise<never>(() => {}), {
      taskTimeoutMs: 10,
    });
    const [hookRun, hookGate] = park(HOOK);
    await expect(timedOut).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    hookGate();
    await hookRun;
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
