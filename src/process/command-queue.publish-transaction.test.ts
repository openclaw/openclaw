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

function clearGroups() {
  for (const group of [GROUP, MOVED_GROUP]) {
    publishLaneConfiguration({ clearGroups: [group] });
  }
}

function park(lane: string, onStart?: () => void, onFinish?: () => void, priority?: "background") {
  const gate = createDeferred();
  const run = enqueueCommandInLane(
    lane,
    async () => {
      onStart?.();
      await gate.promise;
      onFinish?.();
    },
    { priority },
  );
  return { run, resolve: gate.resolve };
}

async function releaseAll(tasks: ReturnType<typeof park>[], clear = false) {
  for (const task of tasks) {
    task.resolve();
  }
  if (clear) {
    clearCommandLane(CRON);
    clearCommandLane(HOOK);
  }
  const runs = tasks.map(({ run }) => run);
  await (clear ? Promise.allSettled(runs) : Promise.all(runs));
}

beforeEach(() => {
  resetAllLanes();
  clearGroups();
});
afterEach(() => {
  clearGroups();
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
    const tasks = [CRON, HOOK].flatMap((lane, index) =>
      Array.from({ length: index === 0 ? 12 : 6 }, () =>
        park(
          lane,
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
      await releaseAll(tasks, true);
    }
  });

  test("commit dispatch uses group order rather than publication object order", async () => {
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 0);
    const starts: string[] = [];
    const cronStarted = createDeferred();
    const hookStarted = createDeferred();
    const cron = park(
      CRON,
      () => {
        starts.push(CRON);
        cronStarted.resolve();
      },
      undefined,
      "background",
    );
    const hook = park(
      HOOK,
      () => {
        starts.push(HOOK);
        hookStarted.resolve();
      },
      undefined,
      "background",
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
    publishLaneConfiguration({
      lanes: { [CRON]: 1, [HOOK]: 1, [DELIVERY]: 1 },
      groups: { [GROUP]: { budget: 1, members: [CRON, HOOK] } },
    });
    const cronGate = park(CRON);
    const cronRun = cronGate.run;
    const hookGate = park(HOOK);
    const hookRun = hookGate.run;
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
    const tasks = Array.from({ length: 4 }, () => park(CRON));
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
    const extra = park(CRON);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);
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
    const tasks = Array.from({ length: 5 }, () => park(CRON));
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 2, queuedCount: 3 });
    setCommandLaneGroup(GROUP, { budget: 5, members: [CRON, HOOK] });
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 5, queuedCount: 0 });
    await releaseAll(tasks);
  });

  test("republishing a narrower budget does not admit beyond the new cap", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    const tasks = Array.from({ length: 3 }, () => park(CRON));
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);
    // Narrowing cannot evict running work or admit more while over budget.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 2, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    const extra = park(CRON);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("group-budget");
    await releaseAll([...tasks, extra], true);
  });
});
