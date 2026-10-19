import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getSkillWorkshopReviewLane, getBackgroundWorkSnapshot } from "./background-work.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
} from "./command-queue.js";
import { getQueueState } from "./command-queue.state.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane } from "./lanes.js";

const state = getQueueState();

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function expectBackground(
  overrides: Partial<ReturnType<typeof getBackgroundWorkSnapshot>> = {},
  actual = getBackgroundWorkSnapshot(),
) {
  expect(actual).toEqual({
    lane: CommandLane.Background,
    activeCount: 0,
    queuedCount: 0,
    maxConcurrent: 3,
    draining: false,
    generation: 0,
    blockedBy: null,
    ...overrides,
  });
}

function countLaneReads<T>(read: () => T) {
  const get = vi.spyOn(state.lanes, "get");
  try {
    return { result: read(), reads: get.mock.calls.length };
  } finally {
    get.mockRestore();
  }
}

function preserveQueueState() {
  const { lanes } = state;
  const group = state.laneGroups.get("background-work");
  const references = () => [
    state.laneGroups.get("background-work"),
    ...[...lanes.values()].flatMap((lane) => [
      lane,
      lane.queue,
      lane.queue.normal.head,
      lane.queue.normal.tail,
    ]),
  ];
  const values = () => ({
    keys: [...lanes.keys()],
    members: [...group!.members],
    memberships: [...state.laneGroupByLane],
    nextTaskId: state.nextTaskId,
    nextQueueSequence: state.nextQueueSequence,
    lanes: [...lanes.values()].map(({ queue, activeTasks, ...lane }) =>
      Object.assign(lane, { queued: queue.length, active: [...activeTasks] }),
    ),
  });
  const refs = references();
  const before = values();
  return () => {
    expect(values()).toEqual(before);
    references().forEach((reference, index) => expect(reference).toBe(refs[index]));
  };
}

type Capacities = Record<string, number>;

function configureBackground(members: string[], lanes?: Capacities, reservations?: Capacities) {
  publishLaneConfiguration({
    lanes,
    groups: { "background-work": { budget: 3, members, reservations } },
  });
}

function park(
  lane: string,
  onStart?: () => void,
  options?: Parameters<typeof enqueueCommandInLane>[2],
) {
  const gate = createDeferred();
  const task = async () => {
    onStart?.();
    await gate.promise;
  };
  const run = enqueueCommandInLane(lane, task, options);
  return { run, resolve: gate.resolve };
}

beforeEach(resetCommandQueueStateForTest);
afterEach(resetCommandQueueStateForTest);

it("does not scan sibling lanes while reading registered owner widths", () => {
  const siblings = Array.from({ length: 32 }, (_, index) => `background:core:stable-${index}`);
  configureBackground(siblings, Object.fromEntries(siblings.map((lane) => [lane, 1])));
  const lane = getSkillWorkshopReviewLane();
  const members = [...siblings, lane];
  expect(state.lanes.size).toBe(members.length);
  for (const registeredLane of state.lanes.values()) {
    expect(registeredLane).toMatchObject({ draining: false, queue: { length: 0 } });
  }
  const unchanged = preserveQueueState();
  const { result: observed, reads } = countLaneReads(() =>
    Array.from({ length: 1_000 }, () => getSkillWorkshopReviewLane()),
  );
  expect(observed).toEqual(Array.from({ length: 1_000 }, () => lane));
  unchanged();
  expect(reads).toBeLessThanOrEqual(1_000);
});

it.each([
  [false, 1],
  [true, 1],
  [true, 2],
] as const)("registers lazily (group-only=%s, width=%i)", (groupOnly, maxConcurrent) => {
  const lane = "background:core:skill-workshop";
  if (groupOnly) {
    configureBackground([lane], maxConcurrent === 1 ? undefined : { [lane]: maxConcurrent });
  }
  expect(state.lanes.size).toBe(groupOnly && maxConcurrent !== 1 ? 1 : 0);
  if (groupOnly) {
    const group = state.laneGroups.get("background-work");
    if (maxConcurrent === 1) {
      expect(getSkillWorkshopReviewLane()).toBe(lane);
    } else {
      expect(() => getSkillWorkshopReviewLane()).toThrow(
        "already registered with different concurrency",
      );
    }
    expect(state.lanes.size).toBe(maxConcurrent === 1 ? 0 : 1);
    expect(state.laneGroups.get("background-work")).toBe(group);
    expect([...group!.members]).toEqual([lane]);
    return;
  }
  expect(state.laneGroups.size).toBe(0);
  expect(getSkillWorkshopReviewLane()).toBe(lane);
  const registered = state.lanes.get(lane);
  const group = state.laneGroups.get("background-work");
  expect(registered?.maxConcurrent).toBe(1);
  expect([...group!.members]).toEqual([lane]);
  expect(getSkillWorkshopReviewLane()).toBe(lane);
  for (const width of [0, 2, 3, 1]) {
    publishLaneConfiguration({ lanes: { [lane]: width } });
    if (width === 1) {
      expect(getSkillWorkshopReviewLane()).toBe(lane);
    } else {
      expect(() => getSkillWorkshopReviewLane()).toThrow(
        "already registered with different concurrency",
      );
    }
    expect(state.lanes.get(lane)).toBe(registered);
    expect(registered?.maxConcurrent).toBe(width);
    expect(state.laneGroups.get("background-work")).toBe(group);
  }
});

it("reads absent and empty background groups without creating lanes", () => {
  expectBackground();
  configureBackground([]);
  expectBackground();
  expect(state.lanes.size).toBe(0);
});

it("reads each background group member once while preserving queue state and block precedence", async () => {
  const members = Array.from({ length: 1_000 }, (_, index) => `background:owner-${index}`);
  const activeLanes = members.slice(0, 3);
  configureBackground(members, Object.fromEntries(activeLanes.map((lane) => [lane, 1])));
  const gates = activeLanes.map((lane) => park(lane));
  const active = gates.map(({ run }) => run);
  const order: number[] = [];
  const queued = [1, 2].map((value) =>
    enqueueCommandInLane(activeLanes[0]!, async () => void order.push(value)),
  );
  try {
    const unchanged = preserveQueueState();
    const { result: snapshot, reads: memberReads } = countLaneReads(getBackgroundWorkSnapshot);
    expectBackground({ activeCount: 3, queuedCount: 2, blockedBy: "group-budget" }, snapshot);
    unchanged();
    expect(state.lanes.size).toBe(3);

    gates.slice(1).forEach((gate) => gate.resolve());
    await Promise.all(active.slice(1));
    expectBackground({ activeCount: 1, queuedCount: 2, blockedBy: "lane" });
    gates[0]!.resolve();
    await Promise.all([...active, ...queued]);
    expect(order).toEqual([1, 2]);
    expectBackground();
    expect(memberReads).toBe(members.length);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled([...active, ...queued]);
  }
});

it.each(["paused", "reserved"] as const)(
  "reports aggregate blocking with a %s lane",
  async (mode) => {
    const lane = "background:waiting";
    const reserved = "background:reserved";
    const members = [lane, reserved];
    const paused = mode === "paused";
    configureBackground(members, { [lane]: paused ? 0 : 1 }, { [reserved]: paused ? 0 : 3 });
    const queued = enqueueCommandInLane(lane, async () => "resumed");
    try {
      expect(getCommandLaneSnapshot(lane).blockedBy).toBe(paused ? "lane" : "sibling-reservation");
      expectBackground({ queuedCount: 1, blockedBy: paused ? "lane" : null });
      expect(state.lanes.has(reserved)).toBe(false);
    } finally {
      configureBackground(members, { [lane]: 1 });
      await queued;
    }
  },
);

it("preserves admission draining and the newest generation across Gateway restarts", async () => {
  const lane = "background:reset";
  const sibling = "background:reset-sibling";
  configureBackground([lane, sibling], { [sibling]: 1 });
  resetAllLanes();
  publishLaneConfiguration({ lanes: { [lane]: 1 } });
  resetAllLanes();
  const started = createDeferred();
  let duringAdmission: ReturnType<typeof getBackgroundWorkSnapshot> | undefined;
  const old = park(lane, started.resolve, {
    warnAfterMs: 0,
    onWait: () => {
      duringAdmission = getBackgroundWorkSnapshot();
    },
  });
  const runs = [old];
  try {
    expect(duringAdmission).toBeDefined();
    expectBackground({ activeCount: 1, draining: true, generation: 2 }, duringAdmission);
    await started.promise;
    expectBackground({ activeCount: 1, generation: 2 });
    resetAllLanes();
    expectBackground({ generation: 3 });
    const fresh = park(lane);
    runs.push(fresh);
    old.resolve();
    await old.run;
    expectBackground({ activeCount: 1, generation: 3 });
    fresh.resolve();
    await fresh.run;
    expectBackground({ generation: 3 });
  } finally {
    runs.forEach((task) => task.resolve());
    await Promise.allSettled(runs.map(({ run }) => run));
  }
});

it("shares three slots, preserves owner widths and FIFO, and leaves foreground capacity free", async () => {
  const parallel = "background:plugin:parallel";
  const serial = getSkillWorkshopReviewLane();
  configureBackground([parallel, serial], { [parallel]: 3 });
  const gates = Array.from({ length: 3 }, () =>
    park(parallel, undefined, { priority: "background" }),
  );
  const parallelRuns = gates.map(({ run }) => run);
  const order: number[] = [];
  const first = park(serial, () => void order.push(1), { priority: "background" });
  const second = enqueueCommandInLane(serial, async () => void order.push(2), {
    priority: "background",
  });
  try {
    expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 2 });
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "foreground")).resolves.toBe(
      "foreground",
    );
    gates[0]!.resolve();
    await parallelRuns[0];
    expect(order).toEqual([1]);
    expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 1 });
    gates.slice(1).forEach((gate) => gate.resolve());
    await Promise.all(parallelRuns);
    expect(getCommandLaneSnapshot(serial)).toMatchObject({ activeCount: 1, queuedCount: 1 });
    first.resolve();
    await Promise.all([first.run, second]);
    expect(order).toEqual([1, 2]);
  } finally {
    gates.forEach((gate) => gate.resolve());
    first.resolve();
    await Promise.all([...parallelRuns, first.run, second]);
  }
});

it("removes cancelled work immediately without invoking it or reordering its successors", async () => {
  const owner = getSkillWorkshopReviewLane();
  const active = park(owner, undefined, { priority: "background" });
  const controller = new AbortController();
  const cancelledTask = vi.fn(async () => undefined);
  const order: number[] = [];
  const first = enqueueCommandInLane(owner, async () => void order.push(1), {
    priority: "background",
  });
  const cancelled = enqueueCommandInLane(owner, cancelledTask, {
    priority: "background",
    abortSignal: controller.signal,
  });
  const last = enqueueCommandInLane(owner, async () => void order.push(2), {
    priority: "background",
  });
  const rejection = expect(cancelled).rejects.toThrow("cancel background work");
  controller.abort(new Error("cancel background work"));
  await rejection;
  expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 2 });
  active.resolve();
  await Promise.all([active.run, first, last]);
  expect(cancelledTask).not.toHaveBeenCalled();
  expect(order).toEqual([1, 2]);
});
