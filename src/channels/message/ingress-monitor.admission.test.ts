import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

describe("channel ingress monitor admission", () => {
  type RawEvent = { id: string; text: string };
  type StoredEvent = { version: 1; rawEvent: string };

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("does not replay or acknowledge an append with a wrapped unknown native outcome", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      stateDir: tempDirs.make("openclaw-ingress-unknown-"),
    });
    const unknown = new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown");
    const failure = new Error("Synthetic cleanup failure", {
      cause: new AggregateError([unknown]),
    });
    const append = queue.enqueue.bind(queue);
    let attempted = false;
    const enqueue = vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
      const result = await append(...args);
      if (!attempted) {
        attempted = true;
        throw failure;
      }
      return result;
    });
    const acknowledged = vi.fn();
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "lane:a" }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      onDurableAdmission: acknowledged,
      appendRetryDelaysMs: [0, 0, 0],
      pollIntervalMs: 60_000,
      retention: { pruneIntervalMs: 60_000 },
    });
    try {
      await expect(monitor.admit({ id: "unknown", text: "one" })).rejects.toBe(failure);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(acknowledged).not.toHaveBeenCalled();
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["unknown"]);
    } finally {
      await monitor.stop();
    }
  });

  it("keeps delayed inspection in FIFO admission and joins it on stop", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-inspection-"),
    });
    const inspection = createDeferred();
    const entered = createDeferred();
    const inspections: string[] = [];
    const admissions: string[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: () => {
        throw new Error("legacy inspection unexpectedly used");
      },
      inspectAsync: async (raw) => {
        inspections.push(raw.id);
        if (raw.id === "first") {
          entered.resolve();
          await inspection.promise;
        }
        return { eventId: raw.id, laneKey: "lane:a" };
      },
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      onDurableAdmission: (raw) => {
        admissions.push(raw.id);
      },
    });
    const first = monitor.admit({ id: "first", text: "one" });
    const second = monitor.admit({ id: "second", text: "two" });
    await entered.promise;
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(inspections).toEqual(["first"]);
      expect(admissions).toEqual([]);
      expect(stopped).toBe(false);
    } finally {
      inspection.resolve();
      await Promise.all([first, second, stopping]);
    }
    expect(inspections).toEqual(["first", "second"]);
    expect(admissions).toEqual(["first", "second"]);
    expect(stopped).toBe(true);
  });

  it("retries a known append failure and reports whether each admission inserted a new row", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-admission-"),
    });
    const append = queue.enqueue.bind(queue);
    const enqueue = vi
      .spyOn(queue, "enqueue")
      .mockRejectedValueOnce(new Error("Synthetic transient append failure"))
      .mockImplementation(append);
    const admissions: boolean[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "lane:a" }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      appendRetryDelaysMs: [0, 0],
      retention: { pruneIntervalMs: 60_000 },
      onDurableAdmission: (_raw, { isNew }) => {
        admissions.push(isNew);
      },
    });

    try {
      await monitor.admit({ id: "event-one", text: "hello" });
      await monitor.admit({ id: "event-one", text: "hello" });
      expect(admissions).toEqual([true, false]);
      expect(enqueue).toHaveBeenCalledTimes(3);
    } finally {
      await monitor.stop();
    }
  });
});

describe("channel ingress monitor asynchronous inspection", () => {
  type RawEvent = { id: string; lane: string };
  type StoredEvent = { version: 1; rawEvent: string };
  type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  function createQueue() {
    return createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-inspection-"),
    });
  }

  function createMonitor(
    queue: ChannelIngressQueue<StoredEvent>,
    options: Pick<
      MonitorOptions,
      | "inspectAsync"
      | "deliver"
      | "abortSignal"
      | "waitForDeliveryIdleOnStop"
      | "drain"
      | "onActivityChange"
    >,
  ) {
    return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: raw.lane }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      pollIntervalMs: 60_000,
      retention: { pruneIntervalMs: 60_000 },
      ...options,
    });
  }

  it.each([
    { cancel: "stop", waitForDeliveryIdleOnStop: false },
    { cancel: "abort", waitForDeliveryIdleOnStop: true },
  ])(
    "joins claim inspection after $cancel with delivery join=$waitForDeliveryIdleOnStop",
    async ({ cancel, waitForDeliveryIdleOnStop }) => {
      const queue = createQueue();
      const inspection = createDeferred();
      const entered = createDeferred();
      const controller = new AbortController();
      const deliver = vi.fn();
      const monitor = createMonitor(queue, {
        inspectAsync: async (raw, context) => {
          if (context.phase === "claim") {
            entered.resolve();
            await inspection.promise;
          }
          return { eventId: raw.id, laneKey: raw.lane };
        },
        deliver,
        abortSignal: controller.signal,
        waitForDeliveryIdleOnStop,
      });
      await monitor.admit({ id: "delayed", lane: "a" });
      monitor.start();
      await entered.promise;
      if (cancel === "abort") {
        controller.abort();
      }
      let stopped = false;
      const stopping = monitor.stop().then(() => {
        stopped = true;
      });
      try {
        await monitor.waitForPumpIdle();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        inspection.resolve();
        await stopping;
        await monitor.waitForIdle();
      }
      expect(stopped).toBe(true);
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it("joins pending inspection after the watchdog retires its claim", async () => {
    const queue = createQueue();
    const release = createDeferred();
    const entered = createDeferred();
    const deliver = vi.fn();
    const monitor = createMonitor(queue, {
      inspectAsync: async (raw, context) => {
        if (context.phase === "claim") {
          entered.resolve();
          await release.promise;
        }
        return { eventId: raw.id, laneKey: raw.lane };
      },
      deliver,
      drain: { startLimit: 1, adoptionStallTimeoutMs: 10 },
    });
    await monitor.admit({ id: "watchdog", lane: "a" });
    monitor.start();
    await entered.promise;
    let idle = false;
    let waiting: Promise<void> | undefined;
    try {
      await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
      waiting = monitor.waitForIdle().then(() => {
        idle = true;
      });
      await monitor.waitForPumpIdle();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(idle).toBe(false);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      const stopping = monitor.stop();
      await waiting;
      await stopping;
    }
    expect(idle).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports busy through inspection until delivery", async () => {
    const queue = createQueue();
    const release = createDeferred();
    const entered = createDeferred();
    const activity: boolean[] = [];
    const deliver = vi.fn(() => {
      expect(activity).not.toContain(false);
    });
    const monitor = createMonitor(queue, {
      inspectAsync: async (raw, context) => {
        if (context.phase === "claim") {
          entered.resolve();
          await release.promise;
        }
        return { eventId: raw.id, laneKey: raw.lane };
      },
      deliver,
      onActivityChange: (active) => {
        activity.push(active);
      },
    });
    await monitor.admit({ id: "activity", lane: "a" });
    monitor.start();
    await entered.promise;
    try {
      await monitor.waitForPumpIdle();
      expect(activity.at(-1)).toBe(true);
      release.resolve();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await monitor.stop();
    }
  });

  it.each([false, true])(
    "reserves start capacity across pump cycles: shared result=%s",
    async (sharedResult) => {
      const queue = createQueue();
      const release = createDeferred();
      const entered = createDeferred();
      const sharedInspection = release.promise.then(() => null);
      const inspections: string[] = [];
      const deliver = vi.fn();
      const monitor = createMonitor(queue, {
        inspectAsync: (raw, context) => {
          const facts = { eventId: raw.id, laneKey: raw.lane };
          if (context.phase !== "claim") {
            return Promise.resolve(facts);
          }
          inspections.push(raw.id);
          if (inspections.length === 2) {
            entered.resolve();
          }
          return sharedResult ? sharedInspection : release.promise.then(() => facts);
        },
        deliver,
        drain: {
          startLimit: 2,
          resolveNonRetryableFailure: (error) =>
            error instanceof Error && error.message === "identity-mismatch"
              ? { reason: "invalid-event", message: error.message }
              : null,
        },
      });
      await monitor.admitBatch([
        { id: "one", lane: "one" },
        { id: "two", lane: "two" },
        { id: "three", lane: "three" },
      ]);
      monitor.start();
      await entered.promise;
      try {
        for (let cycle = 0; cycle < 3; cycle += 1) {
          monitor.requestDrain();
          await monitor.waitForPumpIdle();
        }
        expect(inspections).toHaveLength(2);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await monitor.waitForIdle();
        await monitor.stop();
      }
      expect(inspections).toHaveLength(3);
      expect(deliver).toHaveBeenCalledTimes(sharedResult ? 0 : 3);
    },
  );
});

describe("channel ingress monitor start capacity", () => {
  type RawEvent = { id: string; lane: string; text: string };
  type StoredEvent = { version: 1; rawEvent: string };
  type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  function createMonitor(deliver: MonitorOptions["deliver"], drain: MonitorOptions["drain"]) {
    return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue: createChannelIngressQueue<StoredEvent>({
        channelId: "test",
        accountId: "a",
        stateDir: tempDirs.make("openclaw-ingress-monitor-capacity-"),
      }),
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver,
      pollIntervalMs: 60_000,
      retention: { pruneIntervalMs: 60_000 },
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        ...drain,
      },
    });
  }

  it("stops starting work once the deferred budget is spent, and recovers", async () => {
    const started: string[] = [];
    const parked = createDeferred();
    const monitor = createMonitor(
      async (raw, lifecycle) => {
        started.push(raw.id);
        if (raw.id === "event-after-budget") {
          return { kind: "completed" };
        }
        lifecycle.onDeferred();
        await parked.promise;
        return { kind: "completed" };
      },
      { deferredLaneOccupancy: "release", startLimit: 2 },
    );

    monitor.start();
    try {
      // Two start slots plus a two-deferral budget allow four parked deliveries.
      for (const lane of ["a", "b", "c", "d"]) {
        await monitor.admit({ id: `event-parked-${lane}`, lane, text: lane });
      }
      await monitor.waitForPumpIdle();
      expect(started).toHaveLength(4);

      await monitor.admit({ id: "event-after-budget", lane: "e", text: "e" });
      monitor.requestDrain();
      await monitor.waitForPumpIdle();
      expect(started).not.toContain("event-after-budget");

      parked.resolve();
      await monitor.waitForIdle();
      expect(started).toContain("event-after-budget");
    } finally {
      parked.resolve();
      await monitor.stop();
    }
  });

  it("returns a settled deferral's slot, so the ceiling still holds afterwards", async () => {
    const started: string[] = [];
    const holding = createDeferred();
    const monitor = createMonitor(
      async (raw, lifecycle) => {
        started.push(raw.id);
        if (raw.id.startsWith("event-deferred-")) {
          lifecycle.onDeferred();
          return { kind: "completed" };
        }
        await holding.promise;
        return { kind: "completed" };
      },
      { deferredLaneOccupancy: "release", startLimit: 2 },
    );

    monitor.start();
    try {
      for (const lane of ["a", "b"]) {
        await monitor.admit({ id: `event-deferred-${lane}`, lane, text: lane });
      }
      // Join delivery settlement, which owns returning the borrowed capacity.
      await monitor.waitForIdle();
      expect(started).toHaveLength(2);

      for (const lane of ["c", "d"]) {
        await monitor.admit({ id: `event-holding-${lane}`, lane, text: lane });
      }
      await monitor.waitForPumpIdle();
      expect(started).toHaveLength(4);

      await monitor.admit({ id: "event-over-ceiling", lane: "e", text: "e" });
      monitor.requestDrain();
      await monitor.waitForPumpIdle();
      expect(started).not.toContain("event-over-ceiling");

      holding.resolve();
      await monitor.waitForIdle();
      expect(started).toContain("event-over-ceiling");
    } finally {
      holding.resolve();
      await monitor.stop();
    }
  });

  it("gives no start-slot discount to a drain that holds its lane on deferral", async () => {
    const started: string[] = [];
    const parked = createDeferred();
    const monitor = createMonitor(
      async (raw, lifecycle) => {
        started.push(raw.id);
        lifecycle.onDeferred();
        await parked.promise;
        return { kind: "completed" };
      },
      { startLimit: 1 },
    );

    monitor.start();
    try {
      await monitor.admit({ id: "event-parked", lane: "a", text: "a" });
      await monitor.waitForPumpIdle();
      expect(started).toEqual(["event-parked"]);

      await monitor.admit({ id: "event-second-lane", lane: "b", text: "b" });
      monitor.requestDrain();
      await monitor.waitForPumpIdle();
      expect(started).not.toContain("event-second-lane");

      parked.resolve();
      await monitor.waitForIdle();
      expect(started).toContain("event-second-lane");
    } finally {
      parked.resolve();
      await monitor.stop();
    }
  });
});
