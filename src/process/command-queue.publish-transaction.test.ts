// Atomic publication installs all capacities before dispatch.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "./command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";
const MOVED_GROUP = "cron-delivery";

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
  clearCommandLaneGroup(MOVED_GROUP);
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
  clearCommandLaneGroup(MOVED_GROUP);
  resetAllLanes();
});

describe("publishLaneConfiguration", () => {
  test("no member dispatches above budget DURING publication", async () => {
    // A per-lane drain before group installation would admit 8 + 4 tasks.
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 0);

    let active = 0;
    let peak = 0;
    const publishedStarts = createDeferred();
    const gates: Array<{ resolve: () => void }> = [];
    const runs: Array<Promise<unknown>> = [];
    const park = (lane: string) => {
      const g = createDeferred();
      gates.push(g);
      runs.push(
        enqueueCommandInLane(lane, async () => {
          active += 1;
          // Sample before any task can retire to catch transient over-admission.
          peak = Math.max(peak, active);
          if (active >= 8) {
            publishedStarts.resolve();
          }
          await g.promise;
          active -= 1;
        }),
      );
    };
    for (let i = 0; i < 12; i++) {
      park(CRON);
    }
    for (let i = 0; i < 6; i++) {
      park(HOOK);
    }
    expect(active).toBe(0); // nothing may run before publication
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(0);

    try {
      publishLaneConfiguration({
        lanes: { [CRON]: 8, [HOOK]: 4 },
        groups: {
          [GROUP]: {
            budget: 8,
            members: [CRON, HOOK],
            reservations: { [HOOK]: 1 },
          },
        },
      });

      await withTestTimeout(
        publishedStarts.promise,
        1_000,
        "publication did not start the shared group budget",
      );

      expect(peak).toBe(8);
    } finally {
      for (const g of gates) {
        g.resolve();
      }
      clearCommandLane(CRON);
      clearCommandLane(HOOK);
      await Promise.allSettled(runs);
    }
  });

  test("commit dispatch uses group order rather than publication object order", async () => {
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 0);

    const starts: string[] = [];
    const cronStarted = createDeferred();
    const hookStarted = createDeferred();
    const cronGate = createDeferred();
    const hookGate = createDeferred();
    const olderCron = enqueueCommandInLane(
      CRON,
      async () => {
        starts.push(CRON);
        cronStarted.resolve();
        await cronGate.promise;
      },
      { priority: "background" },
    );
    const newerHook = enqueueCommandInLane(
      HOOK,
      async () => {
        starts.push(HOOK);
        hookStarted.resolve();
        await hookGate.promise;
      },
      { priority: "background" },
    );

    try {
      // HOOK is published first; the older CRON head must still win.
      publishLaneConfiguration({
        lanes: { [HOOK]: 1, [CRON]: 1 },
        groups: { [GROUP]: { budget: 1, members: [HOOK, CRON] } },
      });
      await withTestTimeout(
        cronStarted.promise,
        1_000,
        "publication did not start the older cron task",
      );
      expect(starts).toEqual([CRON]);

      cronGate.resolve();
      await olderCron;
      await withTestTimeout(
        hookStarted.promise,
        1_000,
        "cron completion did not start the queued hook",
      );
      expect(starts).toEqual([CRON, HOOK]);
    } finally {
      cronGate.resolve();
      hookGate.resolve();
      clearCommandLane(CRON);
      clearCommandLane(HOOK);
      await Promise.allSettled([olderCron, newerHook]);
    }
  });

  test("moving a busy member wakes queued work in its previous group", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 1, [HOOK]: 1, [DELIVERY]: 1 },
      groups: { [GROUP]: { budget: 1, members: [CRON, HOOK] } },
    });

    const cronGate = createDeferred();
    const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise);
    const hookGate = createDeferred();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    // Moving active CRON work must immediately free its old group for HOOK.
    publishLaneConfiguration({
      groups: { [MOVED_GROUP]: { budget: 1, members: [CRON, DELIVERY] } },
    });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({
      group: GROUP,
      activeCount: 1,
      queuedCount: 0,
    });
    expect(getCommandLaneSnapshot(CRON).group).toBe(MOVED_GROUP);

    cronGate.resolve();
    hookGate.resolve();
    await Promise.all([cronRun, hookRun]);
  });

  test("a rejected configuration does not leave lane maxima mutated", async () => {
    // Reject before mutating: a later enqueue must not dispatch the preserved queue.
    setCommandLaneConcurrency(CRON, 0);
    const gates = Array.from({ length: 4 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(0);

    expect(() =>
      publishLaneConfiguration({
        lanes: { [CRON]: 8 },
        groups: {
          [GROUP]: {
            budget: 2,
            members: [CRON, HOOK],
            reservations: { [CRON]: 2, [HOOK]: 1 },
          },
        },
      }),
    ).toThrow(/reserves 3 slots but its budget is 2/);

    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(0);
    expect(getCommandLaneSnapshot(CRON).group).toBeUndefined();

    const extra = createDeferred();
    const extraRun = enqueueCommandInLane(CRON, async () => await extra.promise);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);

    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    clearCommandLane(CRON);
    await Promise.allSettled([...runs, extraRun]);
  });

  test("a rejected replacement does not tear down the existing group first", async () => {
    // Validate before clearing the old group or changing its members' widths.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    expect(getCommandLaneSnapshot(CRON).group).toBe(GROUP);

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

    expect(getCommandLaneSnapshot(CRON).group).toBe(GROUP);
    expect(getCommandLaneSnapshot(CRON).groupBudget).toBe(8);
    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(8);
    expect(getCommandLaneSnapshot(HOOK).reservedForLane).toBe(1);
  });

  test("publication wakes members when a replacement frees capacity", async () => {
    // Budget expansion must wake queued work without another enqueue.
    setCommandLaneConcurrency(CRON, 8);
    setCommandLaneConcurrency(HOOK, 1);
    setCommandLaneGroup(GROUP, { budget: 2, members: [CRON, HOOK] });

    const gates = Array.from({ length: 5 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(2);
    expect(getCommandLaneSnapshot(CRON).queuedCount).toBe(3);

    setCommandLaneGroup(GROUP, { budget: 5, members: [CRON, HOOK] });

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(5);
    expect(getCommandLaneSnapshot(CRON).queuedCount).toBe(0);

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  test("republishing a narrower budget does not admit beyond the new cap", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });

    const gates = Array.from({ length: 3 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);

    // Narrowing cannot evict running work or admit more while over budget.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 2, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    const extra = createDeferred();
    const blocked = enqueueCommandInLane(CRON, async () => await extra.promise);

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("group-budget");

    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    clearCommandLane(CRON);
    await Promise.allSettled([...runs, blocked]);
  });
});
