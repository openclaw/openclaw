import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createBackgroundWorkOwner, getBackgroundWorkSnapshot } from "./background-work.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  markGatewayDraining,
  publishLaneConfiguration,
  resetAllLanes,
  resetCommandLane,
} from "./command-queue.js";
import { getQueueState } from "./command-queue.state.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { getGatewayRestartDrainSignal } from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("background work admission", () => {
  beforeEach(resetCommandQueueStateForTest);
  afterEach(resetCommandQueueStateForTest);

  it("does not scan sibling lanes while reading registered owner widths", () => {
    const owners = Array.from({ length: 32 }, (_, index) =>
      createBackgroundWorkOwner({ owner: `core:stable-${index}`, maxConcurrent: (index % 3) + 1 }),
    );
    const members = owners.map((owner) => owner.lane);
    const state = getQueueState();
    const { lanes } = state;
    const group = state.laneGroups.get("background-work");
    const before = [...lanes.values()].map((lane) => ({
      lane,
      width: lane.maxConcurrent,
      queue: lane.queue,
      activeTaskIds: [...lane.activeTaskIds],
      generation: lane.generation,
    }));
    const memberships = [...state.laneGroupByLane];
    const nextTaskId = state.nextTaskId;
    const nextQueueSequence = state.nextQueueSequence;
    const ownGet = Object.getOwnPropertyDescriptor(lanes, "get");
    const originalGet = lanes.get.bind(lanes);
    let reads = 0;
    const observed: string[] = [];
    Object.defineProperty(lanes, "get", {
      configurable: true,
      value: (lane: string) => {
        reads += 1;
        return originalGet(lane);
      },
    });
    try {
      for (let index = 0; index < 1_000; index += 1) {
        observed.push(owners[index % owners.length]!.lane);
      }
    } finally {
      if (ownGet) {
        Object.defineProperty(lanes, "get", ownGet);
      } else {
        Reflect.deleteProperty(lanes, "get");
      }
    }
    expect(observed).toEqual(
      Array.from({ length: 1_000 }, (_, index) => members[index % members.length]),
    );
    expect(lanes.size).toBe(members.length);
    for (const saved of before) {
      expect(lanes.get(saved.lane.lane)).toBe(saved.lane);
      expect(saved.lane.maxConcurrent).toBe(saved.width);
      expect(saved.lane.queue).toBe(saved.queue);
      expect(saved.lane.queue.length).toBe(0);
      expect([...saved.lane.activeTaskIds]).toEqual(saved.activeTaskIds);
      expect(saved.lane.generation).toBe(saved.generation);
      expect(saved.lane.draining).toBe(false);
    }
    expect(state.laneGroups.get("background-work")).toBe(group);
    expect([...group!.members]).toEqual(members);
    expect([...state.laneGroupByLane]).toEqual(memberships);
    expect(state.nextTaskId).toBe(nextTaskId);
    expect(state.nextQueueSequence).toBe(nextQueueSequence);
    expect(reads).toBeLessThanOrEqual(1_000);
  });

  it("registers lazily and checks the current width without replacing matching owners", () => {
    const owner = createBackgroundWorkOwner({ owner: "  core:current-width  ", maxConcurrent: 1 });
    const state = getQueueState();
    expect(state.lanes.size).toBe(0);
    expect(state.laneGroups.size).toBe(0);
    const lane = "background:core:current-width";
    expect(owner.lane).toBe(lane);
    const registered = state.lanes.get(lane);
    const group = state.laneGroups.get("background-work");
    expect(registered?.maxConcurrent).toBe(1);
    expect([...group!.members]).toEqual([lane]);
    expect(createBackgroundWorkOwner({ owner: "core:current-width", maxConcurrent: 1 }).lane).toBe(
      lane,
    );
    for (const width of [0, 2, 3]) {
      publishLaneConfiguration({ lanes: { [lane]: width } });
      expect(() => owner.lane).toThrow("already registered with different concurrency");
      expect(state.lanes.get(lane)).toBe(registered);
      expect(registered?.maxConcurrent).toBe(width);
      expect(state.laneGroups.get("background-work")).toBe(group);
    }
    publishLaneConfiguration({ lanes: { [lane]: 1 } });
    expect(owner.lane).toBe(lane);
    expect(state.lanes.get(lane)).toBe(registered);
    expect(state.laneGroups.get("background-work")).toBe(group);
  });

  it.each([1, 2, 3])("keeps group-only membership lazy for owner width %s", (maxConcurrent) => {
    const lane = "background:core:group-only";
    publishLaneConfiguration({ groups: { "background-work": { budget: 3, members: [lane] } } });
    const state = getQueueState();
    const group = state.laneGroups.get("background-work");
    const owner = createBackgroundWorkOwner({ owner: "core:group-only", maxConcurrent });
    if (maxConcurrent === 1) {
      expect(owner.lane).toBe(lane);
    } else {
      expect(() => owner.lane).toThrow("already registered with different concurrency");
    }
    expect(state.lanes.size).toBe(0);
    expect(state.laneGroups.get("background-work")).toBe(group);
    expect([...group!.members]).toEqual([lane]);
  });

  it("reads absent and empty background groups without creating lanes", () => {
    const expected = {
      lane: CommandLane.Background,
      activeCount: 0,
      queuedCount: 0,
      maxConcurrent: 3,
      draining: false,
      generation: 0,
      blockedBy: null,
    };
    expect(getBackgroundWorkSnapshot()).toEqual(expected);
    publishLaneConfiguration({ groups: { "background-work": { budget: 3, members: [] } } });
    expect(getBackgroundWorkSnapshot()).toEqual(expected);
    expect(getQueueState().lanes.size).toBe(0);
  });

  it("reads each background group member once while preserving queue state and block precedence", async () => {
    const members = Array.from({ length: 1_000 }, (_, index) => `background:owner-${index}`);
    const activeLanes = members.slice(0, 3);
    publishLaneConfiguration({
      lanes: Object.fromEntries(activeLanes.map((lane) => [lane, 1])),
      groups: { "background-work": { budget: 3, members } },
    });
    const gates = activeLanes.map(() => createDeferred());
    const active = activeLanes.map((lane, index) =>
      enqueueCommandInLane(lane, async () => await gates[index]!.promise),
    );
    const order: number[] = [];
    const queued = [1, 2].map((value) =>
      enqueueCommandInLane(activeLanes[0]!, async () => {
        order.push(value);
      }),
    );
    try {
      const queueState = getQueueState();
      const { lanes } = queueState;
      const group = queueState.laneGroups.get("background-work");
      const before = [...lanes.values()].map((state) => ({
        state,
        activeTaskIds: [...state.activeTaskIds],
        queue: state.queue,
        head: state.queue.normal.head,
        tail: state.queue.normal.tail,
        queuedCount: state.queue.length,
      }));
      const nextTaskId = queueState.nextTaskId;
      const nextQueueSequence = queueState.nextQueueSequence;
      const ownGet = Object.getOwnPropertyDescriptor(lanes, "get");
      const originalGet = lanes.get.bind(lanes);
      let memberReads = 0;
      let snapshot: ReturnType<typeof getBackgroundWorkSnapshot>;
      // Count real native-map reads without retaining a million mock call records.
      Object.defineProperty(lanes, "get", {
        configurable: true,
        value: (lane: string) => {
          memberReads += 1;
          return originalGet(lane);
        },
      });
      try {
        snapshot = getBackgroundWorkSnapshot();
      } finally {
        if (ownGet) {
          Object.defineProperty(lanes, "get", ownGet);
        } else {
          Reflect.deleteProperty(lanes, "get");
        }
      }
      expect(snapshot).toEqual({
        lane: CommandLane.Background,
        activeCount: 3,
        queuedCount: 2,
        maxConcurrent: 3,
        draining: false,
        generation: 0,
        blockedBy: "group-budget",
      });
      expect(lanes.size).toBe(3);
      for (const saved of before) {
        expect(lanes.get(saved.state.lane)).toBe(saved.state);
        expect([...saved.state.activeTaskIds]).toEqual(saved.activeTaskIds);
        expect(saved.state.queue).toBe(saved.queue);
        expect(saved.state.queue.normal.head).toBe(saved.head);
        expect(saved.state.queue.normal.tail).toBe(saved.tail);
        expect(saved.state.queue.length).toBe(saved.queuedCount);
      }
      expect(queueState.laneGroups.get("background-work")).toBe(group);
      expect([...group!.members]).toEqual(members);
      expect(queueState.nextTaskId).toBe(nextTaskId);
      expect(queueState.nextQueueSequence).toBe(nextQueueSequence);

      gates[1]!.resolve();
      gates[2]!.resolve();
      await Promise.all(active.slice(1));
      expect(getBackgroundWorkSnapshot()).toEqual({
        ...snapshot,
        activeCount: 1,
        blockedBy: "lane",
      });
      gates[0]!.resolve();
      await Promise.all([...active, ...queued]);
      expect(order).toEqual([1, 2]);
      expect(getBackgroundWorkSnapshot()).toEqual({
        ...snapshot,
        activeCount: 0,
        queuedCount: 0,
        blockedBy: null,
      });
      expect(memberReads).toBe(members.length);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.allSettled([...active, ...queued]);
    }
  });

  it("reports queued work in a paused background lane as lane-blocked", async () => {
    const lane = "background:paused";
    publishLaneConfiguration({
      lanes: { [lane]: 0 },
      groups: { "background-work": { budget: 3, members: [lane] } },
    });
    const queued = enqueueCommandInLane(lane, async () => "resumed");
    try {
      expect(getBackgroundWorkSnapshot()).toEqual({
        lane: CommandLane.Background,
        activeCount: 0,
        queuedCount: 1,
        maxConcurrent: 3,
        draining: false,
        generation: 0,
        blockedBy: "lane",
      });
    } finally {
      publishLaneConfiguration({ lanes: { [lane]: 1 } });
      await queued;
    }
  });

  it("keeps sibling reservations out of the background aggregate block reason", async () => {
    const waiting = "background:waiting";
    const reserved = "background:reserved";
    const members = [waiting, reserved];
    publishLaneConfiguration({
      lanes: { [waiting]: 1 },
      groups: { "background-work": { budget: 3, members, reservations: { [reserved]: 3 } } },
    });
    const queued = enqueueCommandInLane(waiting, async () => "unreserved");
    try {
      expect(getCommandLaneSnapshot(waiting).blockedBy).toBe("sibling-reservation");
      expect(getBackgroundWorkSnapshot()).toEqual({
        lane: CommandLane.Background,
        activeCount: 0,
        queuedCount: 1,
        maxConcurrent: 3,
        draining: false,
        generation: 0,
        blockedBy: null,
      });
      expect(getQueueState().lanes.has(reserved)).toBe(false);
    } finally {
      publishLaneConfiguration({ groups: { "background-work": { budget: 3, members } } });
      await queued;
    }
  });

  it("preserves admission draining and the newest generation across real lane resets", async () => {
    const lane = "background:reset";
    const sibling = "background:reset-sibling";
    publishLaneConfiguration({
      lanes: { [lane]: 1, [sibling]: 1 },
      groups: { "background-work": { budget: 3, members: [lane, sibling] } },
    });
    resetCommandLane(lane);
    resetCommandLane(sibling);
    resetCommandLane(sibling);
    const started = createDeferred();
    const oldGate = createDeferred();
    const freshGate = createDeferred();
    let duringAdmission: ReturnType<typeof getBackgroundWorkSnapshot> | undefined;
    const old = enqueueCommandInLane(
      lane,
      async () => {
        started.resolve();
        await oldGate.promise;
      },
      {
        warnAfterMs: 0,
        onWait: () => {
          duringAdmission = getBackgroundWorkSnapshot();
        },
      },
    );
    const runs = [old];
    try {
      expect(duringAdmission).toEqual({
        lane: CommandLane.Background,
        activeCount: 1,
        queuedCount: 0,
        maxConcurrent: 3,
        draining: true,
        generation: 2,
        blockedBy: null,
      });
      await started.promise;
      expect(getBackgroundWorkSnapshot()).toEqual({ ...duringAdmission, draining: false });
      resetAllLanes();
      expect(getBackgroundWorkSnapshot()).toEqual({
        ...duringAdmission,
        activeCount: 0,
        draining: false,
        generation: 3,
      });
      const fresh = enqueueCommandInLane(lane, async () => await freshGate.promise);
      runs.push(fresh);
      oldGate.resolve();
      await old;
      expect(getBackgroundWorkSnapshot()).toEqual({
        ...duringAdmission,
        draining: false,
        generation: 3,
      });
      freshGate.resolve();
      await fresh;
      expect(getBackgroundWorkSnapshot()).toEqual({
        ...duringAdmission,
        activeCount: 0,
        draining: false,
        generation: 3,
      });
    } finally {
      oldGate.resolve();
      freshGate.resolve();
      await Promise.allSettled(runs);
    }
  });

  it("shares three slots, preserves owner widths and FIFO, and leaves foreground capacity free", async () => {
    const parallel = createBackgroundWorkOwner({ owner: "plugin:parallel", maxConcurrent: 3 });
    const serial = createBackgroundWorkOwner({ owner: "core:serial", maxConcurrent: 1 });
    const gates = Array.from({ length: 3 }, () => createDeferred());
    const parallelRuns = gates.map((gate) => parallel.enqueue(async () => await gate.promise));
    const serialGate = createDeferred();
    const order: number[] = [];
    const first = serial.enqueue(async () => {
      order.push(1);
      await serialGate.promise;
    });
    const second = serial.enqueue(async () => {
      order.push(2);
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
      gates[1]!.resolve();
      gates[2]!.resolve();
      await Promise.all(parallelRuns);
      expect(getCommandLaneSnapshot(serial.lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      serialGate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
    } finally {
      gates.forEach((gate) => gate.resolve());
      serialGate.resolve();
      await Promise.all([...parallelRuns, first, second]);
    }
  });

  it("removes cancelled work immediately without invoking it or reordering its successors", async () => {
    const owner = createBackgroundWorkOwner({ owner: "core:cancel", maxConcurrent: 1 });
    const gate = createDeferred();
    const active = owner.enqueue(async () => await gate.promise);
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => undefined);
    const order: number[] = [];
    const first = owner.enqueue(async () => {
      order.push(1);
    });
    const cancelled = owner.enqueue(cancelledTask, { abortSignal: controller.signal });
    const last = owner.enqueue(async () => {
      order.push(2);
    });
    const rejection = expect(cancelled).rejects.toThrow("cancel background work");
    controller.abort(new Error("cancel background work"));
    await rejection;
    expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 2 });
    gate.resolve();
    await Promise.all([active, first, last]);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(order).toEqual([1, 2]);
  });

  it.each(["drain", "reset"])(
    "cancels old work on restart %s and admits fresh work",
    async (restart) => {
      const owner = createBackgroundWorkOwner({ owner: "core:restart", maxConcurrent: 1 });
      const started = createDeferred();
      const active = owner.enqueue(async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      });
      await started.promise;
      const staleTask = vi.fn(async () => undefined);
      const stale = owner.enqueue(staleTask);
      const oldSignal = getGatewayRestartDrainSignal();
      const activeRejected = expect(active).rejects.toThrow(/draining for restart|runtime reset/u);
      const staleRejected = expect(stale).rejects.toThrow(/draining for restart|runtime reset/u);
      if (restart === "drain") {
        markGatewayDraining();
      } else {
        resetAllLanes();
      }
      await Promise.all([activeRejected, staleRejected]);
      resetAllLanes();
      expect(oldSignal.aborted).toBe(true);
      expect(getGatewayRestartDrainSignal().aborted).toBe(false);
      await expect(owner.enqueue(async () => "fresh")).resolves.toBe("fresh");
      expect(staleTask).not.toHaveBeenCalled();
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 });
    },
  );
});
