// Capacity groups share a hard budget with non-borrowable member reservations.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import { CommandLane } from "./lanes.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";

type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];

function setCommandLaneGroup(group: string, spec: LaneGroupSpec): void {
  publishLaneConfiguration({ groups: { [group]: spec } });
}

function clearCommandLaneGroup(group: string): void {
  publishLaneConfiguration({ clearGroups: [group] });
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  setCommandLaneConcurrency(CRON, 8);
  setCommandLaneConcurrency(HOOK, 8);
  setCommandLaneConcurrency(DELIVERY, 8);
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
  resetAllLanes();
});

describe("command lane capacity groups", () => {
  test("a reserved lane starts under sibling saturation", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

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
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("sibling-reservation");

    const hookGate = createDeferred();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
      onQueued: () => waiting.push(HOOK),
    });
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(8);
    expect(waiting).toEqual([CRON]);

    hookGate.resolve();
    await hookRun;
    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    await Promise.all([...cronRuns, blockedCron]);
  });

  test("a member may use the full group budget beyond its reservation", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 9 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(HOOK, async () => await g.promise));

    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({
      activeCount: 8,
      queuedCount: 1,
      maxConcurrent: 8,
      groupActive: 8,
      groupBudget: 8,
      reservedForLane: 1,
      blockedBy: "lane",
    });

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  test.each(["successful", "failing"] as const)(
    "a %s completion gives shared capacity to the older eligible sibling head",
    async (outcome) => {
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CRON, HOOK],
        reservations: { [HOOK]: 1 },
      });

      const firstHookGate = createDeferred();
      const secondHookGate = createDeferred();
      const firstHook = enqueueCommandInLane(
        HOOK,
        async () => {
          await firstHookGate.promise;
          if (outcome === "failing") {
            throw new Error("expected hook failure");
          }
        },
        { priority: "background" },
      );
      const secondHook = enqueueCommandInLane(HOOK, async () => await secondHookGate.promise, {
        priority: "background",
      });
      expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(2);

      // The completing HOOK lane must not reclaim the slot ahead of older CRON work.
      const cronGate = createDeferred();
      const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
        priority: "background",
      });
      const thirdHookGate = createDeferred();
      const thirdHook = enqueueCommandInLane(HOOK, async () => await thirdHookGate.promise, {
        priority: "background",
      });

      firstHookGate.resolve();
      if (outcome === "failing") {
        await expect(firstHook).rejects.toThrow("expected hook failure");
      } else {
        await firstHook;
      }

      expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
      expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });

      cronGate.resolve();
      secondHookGate.resolve();
      thirdHookGate.resolve();
      await Promise.all([cronRun, secondHook, thirdHook]);
    },
  );

  test("priority outranks group-global enqueue sequence", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const blockerGate = createDeferred();
    const blocker = enqueueCommandInLane(HOOK, async () => await blockerGate.promise);

    const cronGate = createDeferred();
    const olderBackground = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const hookGate = createDeferred();
    const newerForeground = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "foreground",
    });

    blockerGate.resolve();
    await blocker;

    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    hookGate.resolve();
    await newerForeground;
    cronGate.resolve();
    await olderBackground;
  });

  test("three-member arbitration is independent of member iteration order", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK, DELIVERY] });

    const blockerGate = createDeferred();
    const blocker = enqueueCommandInLane(CRON, async () => await blockerGate.promise, {
      priority: "background",
    });

    // DELIVERY queues first but is visited last; FIFO must win over iteration order.
    const deliveryGate = createDeferred();
    const olderDelivery = enqueueCommandInLane(DELIVERY, async () => await deliveryGate.promise, {
      priority: "background",
    });
    const hookGate = createDeferred();
    const newerHook = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
    });

    blockerGate.resolve();
    await blocker;

    expect(getCommandLaneSnapshot(DELIVERY)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    deliveryGate.resolve();
    await olderDelivery;
    hookGate.resolve();
    await newerHook;
  });

  test("multi-slot reset re-arbitrates before stale completions arrive", async () => {
    setCommandLaneGroup(GROUP, { budget: 2, members: [CRON, HOOK] });

    const staleGates = [createDeferred(), createDeferred()];
    const staleHooks = staleGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );

    const cronGate = createDeferred();
    const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const queuedHookGates = [createDeferred(), createDeferred()];
    const queuedHooks = queuedHookGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );

    expect(resetCommandLane(HOOK)).toBe(2);
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(2);

    // Stale completions must neither retire new task IDs nor admit the queued hook.
    for (const g of staleGates) {
      g.resolve();
    }
    await Promise.all(staleHooks);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });

    cronGate.resolve();
    queuedHookGates[0]?.resolve();
    await Promise.all([cronRun, queuedHooks[0]]);
    queuedHookGates[1]?.resolve();
    await queuedHooks[1];
  });

  test("resetAllLanes refills a group by queue order rather than lane order", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [HOOK, CRON] });

    const staleGate = createDeferred();
    const staleHook = enqueueCommandInLane(HOOK, async () => await staleGate.promise, {
      priority: "background",
    });

    const cronGate = createDeferred();
    const olderCron = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const hookGate = createDeferred();
    const newerHook = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
    });

    resetAllLanes();
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    staleGate.resolve();
    await staleHook;
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).queuedCount).toBe(1);

    cronGate.resolve();
    await olderCron;
    hookGate.resolve();
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
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    cronGate.resolve();
    await cronRun;
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    hookGate.resolve();
    await hookRun;
    expect(peak).toBe(1);
  });

  test("a timed-out task releases group capacity to a queued sibling", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const timedOut = enqueueCommandInLane(CRON, async () => new Promise<never>(() => {}), {
      taskTimeoutMs: 10,
    });
    const hookGate = createDeferred();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);

    await expect(timedOut).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);

    hookGate.resolve();
    await hookRun;
  });

  test("blockedBy reports hypothetical immediate admission with an EMPTY queue", async () => {
    // Pre-enqueue watchdog snapshots must report capacity waits even with no queued head.
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 7 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));

    const snapshot = getCommandLaneSnapshot(CRON);
    expect(snapshot.queuedCount).toBe(0);
    expect(snapshot.activeCount).toBeLessThan(snapshot.maxConcurrent);
    expect(snapshot.blockedBy).toBe("sibling-reservation");

    expect(getCommandLaneSnapshot(HOOK).blockedBy).toBeNull();

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  test("lanes outside any group are unconstrained by it", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });
    setCommandLaneConcurrency("unpooled", 4);

    const gates = Array.from({ length: 4 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane("unpooled", async () => await g.promise));
    expect(getCommandLaneSnapshot("unpooled").activeCount).toBe(4);
    expect(getCommandLaneSnapshot("unpooled").blockedBy).toBe("lane");
    expect(getCommandLaneSnapshot("unpooled").group).toBeUndefined();

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  test("rejects lanes that can be synchronously awaited", () => {
    // `cron` awaits `cron-nested`; grouping them turns a wait into a deadlock.
    expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: ["cron", HOOK] })).toThrow(
      /cannot join a capacity group/,
    );
    for (const lane of ["session:abc", "subagent:agent:main:parent"]) {
      expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: [lane, HOOK] })).toThrow(
        /cannot join a capacity group/,
      );
    }
    expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: ["main", HOOK] })).toThrow(
      /cannot join a capacity group/,
    );
    expect(() =>
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CommandLane.SystemAgent, HOOK],
      }),
    ).toThrow(/cannot join a capacity group/);

    expect(() =>
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CommandLane.SystemAgentInference, HOOK],
      }),
    ).not.toThrow();
  });

  test("rejects a reservation for a non-member lane", () => {
    expect(() =>
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CRON],
        reservations: { [HOOK]: 1 },
      }),
    ).toThrow(/reserves for non-member lane/);
  });
});
