import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type StoredEvent = { version: 1; rawEvent: string };
type RawEvent = { id: string; lane: string };
type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent>;
const event = (id: string, lane = "a"): RawEvent => ({ id, lane });

describe("channel ingress monitor admission", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  function createQueue() {
    return createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-admission-"),
    });
  }

  function createMonitor(options: Partial<Omit<MonitorOptions, "payload">> = {}) {
    return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue: options.queue ?? createQueue(),
      inspect: (raw) => ({ eventId: raw.id, laneKey: raw.lane }),
      deliver: vi.fn(),
      pollIntervalMs: 60_000,
      retention: { pruneIntervalMs: 60_000 },
      ...options,
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
    });
  }

  function holdClaimInspection() {
    const release = createDeferred();
    const entered = createDeferred();
    const inspectAsync: NonNullable<MonitorOptions["inspectAsync"]> = async (raw, context) => {
      if (context.phase === "claim") {
        entered.resolve();
        await release.promise;
      }
      return { eventId: raw.id, laneKey: raw.lane };
    };
    return { release, entered, inspectAsync };
  }

  it("does not replay or acknowledge an append with a wrapped unknown native outcome", async () => {
    const queue = createQueue();
    const unknown = new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown");
    const failure = new Error("Synthetic cleanup failure", {
      cause: new AggregateError([unknown]),
    });
    const append = queue.enqueue.bind(queue);
    const enqueue = vi
      .spyOn(queue, "enqueue")
      .mockImplementationOnce(async (...args) => {
        await append(...args);
        throw failure;
      })
      .mockImplementation(append);
    const acknowledged = vi.fn();
    const monitor = createMonitor({
      queue,
      onDurableAdmission: acknowledged,
      appendRetryDelaysMs: [0, 0, 0],
    });
    try {
      await expect(monitor.admit(event("unknown"))).rejects.toBe(failure);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(acknowledged).not.toHaveBeenCalled();
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["unknown"]);
    } finally {
      await monitor.stop();
    }
  });

  it("keeps delayed inspection in FIFO admission and joins it on stop", async () => {
    const inspection = createDeferred();
    const entered = createDeferred();
    const inspections: string[] = [];
    const admissions: string[] = [];
    const monitor = createMonitor({
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
      onDurableAdmission: (raw) => {
        admissions.push(raw.id);
      },
    });
    const first = monitor.admit(event("first"));
    const second = monitor.admit(event("second"));
    await entered.promise;
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect([inspections, admissions, stopped]).toEqual([["first"], [], false]);
    } finally {
      inspection.resolve();
      await Promise.all([first, second, stopping]);
    }
    expect(inspections).toEqual(["first", "second"]);
    expect(admissions).toEqual(["first", "second"]);
    expect(stopped).toBe(true);
  });

  it("retries a known append failure and reports whether each admission inserted a new row", async () => {
    const queue = createQueue();
    const append = queue.enqueue.bind(queue);
    const enqueue = vi
      .spyOn(queue, "enqueue")
      .mockRejectedValueOnce(new Error("Synthetic transient append failure"))
      .mockImplementation(append);
    const admissions: boolean[] = [];
    const monitor = createMonitor({
      queue,
      appendRetryDelaysMs: [0, 0],
      onDurableAdmission: (_raw, { isNew }) => {
        admissions.push(isNew);
      },
    });

    try {
      await monitor.admit(event("event-one"));
      await monitor.admit(event("event-one"));
      expect(admissions).toEqual([true, false]);
      expect(enqueue).toHaveBeenCalledTimes(3);
    } finally {
      await monitor.stop();
    }
  });
  it.each([
    { cancel: "stop", waitForDeliveryIdleOnStop: false },
    { cancel: "abort", waitForDeliveryIdleOnStop: true },
    { cancel: "watchdog", waitForDeliveryIdleOnStop: true },
  ])(
    "joins claim inspection after $cancel with delivery join=$waitForDeliveryIdleOnStop",
    async ({ cancel, waitForDeliveryIdleOnStop }) => {
      const queue = createQueue();
      const { release: inspection, entered, inspectAsync } = holdClaimInspection();
      const controller = new AbortController();
      const deliver = vi.fn();
      const monitor = createMonitor({
        queue,
        inspectAsync,
        deliver,
        abortSignal: controller.signal,
        waitForDeliveryIdleOnStop,
        ...(cancel === "watchdog" ? { drain: { startLimit: 1, adoptionStallTimeoutMs: 10 } } : {}),
      });
      await monitor.admit(event("delayed"));
      monitor.start();
      await entered.promise;
      if (cancel === "abort") {
        controller.abort();
      }
      let joined = false;
      let waiting: Promise<void> | undefined;
      try {
        if (cancel === "watchdog") {
          await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
        }
        waiting = (cancel === "watchdog" ? monitor.waitForIdle() : monitor.stop()).then(() => {
          joined = true;
        });
        await monitor.waitForPumpIdle();
        await tick();
        expect(joined).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        inspection.resolve();
        const stopping = monitor.stop();
        await waiting;
        await stopping;
        await monitor.waitForIdle();
      }
      expect(joined).toBe(true);
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it("reports busy through inspection until delivery", async () => {
    const { release, entered, inspectAsync } = holdClaimInspection();
    const activity: boolean[] = [];
    const deliver = vi.fn(() => {
      expect(activity).not.toContain(false);
    });
    const monitor = createMonitor({
      inspectAsync,
      deliver,
      onActivityChange: (active) => {
        activity.push(active);
      },
    });
    await monitor.admit(event("activity"));
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
      const release = createDeferred();
      const entered = createDeferred();
      const sharedInspection = release.promise.then(() => null);
      const inspections: string[] = [];
      const deliver = vi.fn();
      const monitor = createMonitor({
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
      await monitor.admitBatch(["one", "two", "three"].map((id) => event(id, id)));
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
  function createCapacityMonitor(
    drain: MonitorOptions["drain"],
    prepare: (...args: Parameters<MonitorOptions["deliver"]>) => "complete" | void = (
      _raw,
      lifecycle,
    ) => lifecycle.onDeferred(),
  ) {
    const started: string[] = [];
    const release = createDeferred();
    const monitor = createMonitor({
      deliver: async (...args) => {
        started.push(args[0].id);
        if (prepare(...args) !== "complete") {
          await release.promise;
        }
        return { kind: "completed" };
      },
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        ...drain,
      },
    });
    return { monitor, started, release };
  }

  async function expectCapacityRecovery(
    { monitor, started, release }: ReturnType<typeof createCapacityMonitor>,
    id: string,
    lane: string,
  ) {
    await monitor.admit(event(id, lane));
    monitor.requestDrain();
    await monitor.waitForPumpIdle();
    expect(started).not.toContain(id);
    release.resolve();
    await monitor.waitForIdle();
    expect(started).toContain(id);
  }

  it("stops starting work once the deferred budget is spent, and recovers", async () => {
    const capacity = createCapacityMonitor(
      { deferredLaneOccupancy: "release", startLimit: 2 },
      (raw, lifecycle) => {
        if (raw.id === "event-after-budget") {
          return "complete";
        }
        lifecycle.onDeferred();
      },
    );
    const { monitor, started, release } = capacity;
    monitor.start();
    try {
      // Two start slots plus a two-deferral budget allow four parked deliveries.
      for (const lane of ["a", "b", "c", "d"]) {
        await monitor.admit(event(`event-parked-${lane}`, lane));
      }
      await monitor.waitForPumpIdle();
      expect(started).toHaveLength(4);

      await expectCapacityRecovery(capacity, "event-after-budget", "e");
    } finally {
      release.resolve();
      await monitor.stop();
    }
  });

  it("returns a settled deferral's slot, so the ceiling still holds afterwards", async () => {
    const capacity = createCapacityMonitor(
      { deferredLaneOccupancy: "release", startLimit: 2 },
      (raw, lifecycle) => {
        if (raw.id.startsWith("event-deferred-")) {
          lifecycle.onDeferred();
          return "complete";
        }
      },
    );
    const { monitor, started, release } = capacity;
    monitor.start();
    try {
      for (const lane of ["a", "b"]) {
        await monitor.admit(event(`event-deferred-${lane}`, lane));
      }
      // Join delivery settlement, which owns returning the borrowed capacity.
      await monitor.waitForIdle();
      expect(started).toHaveLength(2);

      for (const lane of ["c", "d"]) {
        await monitor.admit(event(`event-holding-${lane}`, lane));
      }
      await monitor.waitForPumpIdle();
      expect(started).toHaveLength(4);

      await expectCapacityRecovery(capacity, "event-over-ceiling", "e");
    } finally {
      release.resolve();
      await monitor.stop();
    }
  });

  it.each([
    { startLimit: 1, capacity: 1 },
    { startLimit: undefined, capacity: 32 },
  ])(
    "bounds held deliveries across pumps at $capacity while admitting durable input",
    async ({ startLimit, capacity }) => {
      const capacityState = createCapacityMonitor({ startLimit });
      const { monitor, started, release } = capacityState;
      monitor.start();
      try {
        for (let index = 0; index < capacity; index++) {
          await monitor.admit(event(`event-parked-${index}`, `${index}`));
        }
        await monitor.waitForPumpIdle();
        expect(started).toHaveLength(capacity);

        await expectCapacityRecovery(capacityState, "event-second-lane", "b");
      } finally {
        release.resolve();
        await monitor.stop();
      }
    },
  );
});
