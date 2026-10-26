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

type StoredEvent = { version: 1; rawEvent: string };
type RawEvent = { id: string; text?: string; lane?: string };
type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;
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

function createMonitor(
  queue: ChannelIngressQueue<StoredEvent>,
  options: Partial<Omit<MonitorOptions, "queue" | "payload">>,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: raw.lane ?? "lane:a" }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver: vi.fn(),
    pollIntervalMs: 60_000,
    retention: { pruneIntervalMs: 60_000 },
    ...options,
  });
}

function holdClaimInspection() {
  const entered = createDeferred();
  const release = createDeferred();
  const inspectAsync: MonitorOptions["inspectAsync"] = async (raw, context) => {
    if (context.phase === "claim") {
      entered.resolve();
      await release.promise;
    }
    return { eventId: raw.id, laneKey: raw.lane ?? "lane:a" };
  };
  return { entered, release, inspectAsync };
}

describe("channel ingress monitor admission", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "keeps legacy queues only for unprotected intake (policy=%s batch=%s)",
    async (policy, batch) => {
      const queue = createChannelIngressQueue<StoredEvent>({
        channelId: "test",
        stateDir: tempDirs.make("openclaw-ingress-policy-compat-"),
      });
      const legacy: ChannelIngressQueue<StoredEvent> = {
        ...queue,
        enqueueAuthorized: undefined,
        enqueueBatchAuthorized: undefined,
      };
      const monitor = createMonitor(legacy, {
        prepareAdmission: async (raw) =>
          policy ? { raw, assertCurrent: () => undefined } : undefined,
        retention: "standard",
      });
      try {
        const events = [
          { id: "first", text: "one" },
          { id: "second", text: "two" },
        ];
        const admission = batch ? monitor.admitBatch(events) : monitor.admit(events[0]!);
        if (policy) {
          await expect(admission).rejects.toThrow(/requires an authorized/);
          expect(await queue.listPending()).toEqual([]);
        } else {
          await admission;
          expect((await queue.listPending()).map((row) => row.id)).toEqual(
            batch ? ["first", "second"] : ["first"],
          );
        }
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each(["outcome-unknown", "retryable"] as const)(
    "settles %s append failure without duplicate acknowledgment",
    async (kind) => {
      const queue = createQueue();
      const failure =
        kind === "outcome-unknown"
          ? new Error("cleanup failure", {
              cause: new AggregateError([new SqliteWorkerError("lost native outcome", kind)]),
            })
          : new Error("transient append failure");
      const append = queue.enqueue.bind(queue);
      const enqueue = vi
        .spyOn(queue, "enqueue")
        .mockImplementationOnce(async (...args) => {
          if (kind === "outcome-unknown") {
            await append(...args);
          }
          throw failure;
        })
        .mockImplementation(append);
      const admissions: boolean[] = [];
      const monitor = createMonitor(queue, {
        appendRetryDelaysMs: kind === "outcome-unknown" ? [0, 0, 0] : [0, 0],
        onDurableAdmission: (_raw, { isNew }) => {
          admissions.push(isNew);
        },
      });
      const event = { id: "event", text: "one" };
      try {
        if (kind === "outcome-unknown") {
          await expect(monitor.admit(event)).rejects.toBe(failure);
          expect(enqueue).toHaveBeenCalledOnce();
        } else {
          await monitor.admit(event);
          await monitor.admit(event);
          expect(enqueue).toHaveBeenCalledTimes(3);
        }
        expect(admissions).toEqual(kind === "outcome-unknown" ? [] : [true, false]);
        expect((await queue.listPending()).map((row) => row.id)).toEqual(["event"]);
      } finally {
        await monitor.stop();
      }
    },
  );

  it("keeps delayed inspection in FIFO admission and joins it on stop", async () => {
    const queue = createQueue();
    const inspection = createDeferred();
    const entered = createDeferred();
    const inspections: string[] = [];
    const admissions: string[] = [];
    const monitor = createMonitor(queue, {
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
      pollIntervalMs: 10,
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
});

describe("channel ingress monitor asynchronous inspection", () => {
  it.each([
    ["stop", false],
    ["abort", true],
    ["watchdog", undefined],
    ["deliver", undefined],
  ] as const)("joins held claim inspection through %s", async (mode, waitForDeliveryIdleOnStop) => {
    const queue = createQueue();
    const { release, entered, inspectAsync } = holdClaimInspection();
    const controller = new AbortController();
    const activity: boolean[] = [];
    const deliver = vi.fn(() => {
      if (mode === "deliver") {
        expect(activity).not.toContain(false);
      }
    });
    const monitor = createMonitor(queue, {
      inspectAsync,
      deliver,
      abortSignal: controller.signal,
      waitForDeliveryIdleOnStop,
      onActivityChange: (active) => activity.push(active),
      ...(mode === "watchdog" ? { drain: { startLimit: 1, adoptionStallTimeoutMs: 10 } } : {}),
    });
    await monitor.admit({ id: "held", lane: "a" });
    monitor.start();
    await entered.promise;
    if (mode === "abort") {
      controller.abort();
    }
    if (mode === "watchdog") {
      await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
    }
    let settled = false;
    const waiting = (
      mode === "stop" || mode === "abort" ? monitor.stop() : monitor.waitForIdle()
    ).then(() => {
      settled = true;
    });
    try {
      await monitor.waitForPumpIdle();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(deliver).not.toHaveBeenCalled();
      if (mode === "deliver") {
        expect(activity.at(-1)).toBe(true);
        release.resolve();
        await waiting;
        expect(activity.at(-1)).toBe(false);
        expect(deliver).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      await monitor.stop();
      await waiting;
      await monitor.waitForIdle();
    }
    expect(settled).toBe(true);
    if (mode !== "deliver") {
      expect(deliver).not.toHaveBeenCalled();
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
          const facts = { eventId: raw.id, laneKey: raw.lane ?? "lane:a" };
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
  function createCapacityMonitor(
    deliver: MonitorOptions["deliver"],
    drain: MonitorOptions["drain"],
  ) {
    return createMonitor(createQueue(), {
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      deliver,
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        ...drain,
      },
    });
  }

  it.each([
    ["released deferral budget", 2, true, false, 4],
    ["returned deferral slots", 2, true, true, 2],
    ["held lane", 1, false, false, 1],
    ["default held limit", undefined, false, false, 32],
  ] as const)(
    "bounds deliveries across pumps at %s and recovers",
    async (_name, startLimit, releaseLane, settled, capacity) => {
      const started: string[] = [];
      const parked = createDeferred();
      const monitor = createCapacityMonitor(
        async (raw, lifecycle) => {
          started.push(raw.id);
          if (raw.id === "next" && releaseLane && !settled) {
            return { kind: "completed" };
          }
          if (raw.id.startsWith("deferred-") || !settled) {
            lifecycle.onDeferred();
          }
          if (!raw.id.startsWith("deferred-")) {
            await parked.promise;
          }
          return { kind: "completed" };
        },
        { startLimit, deferredLaneOccupancy: releaseLane ? "release" : "hold" },
      );
      const admit = async (prefix: string, count: number) => {
        for (let index = 0; index < count; index++) {
          await monitor.admit({ id: prefix + index, lane: prefix + index, text: "a" });
        }
      };
      monitor.start();
      try {
        if (settled) {
          await admit("deferred-", 2);
          await monitor.waitForIdle();
          expect(started).toHaveLength(2);
        }
        await admit("parked-", capacity);
        await monitor.waitForPumpIdle();
        expect(started).toHaveLength(capacity + (settled ? 2 : 0));
        await monitor.admit({ id: "next", lane: "next", text: "b" });
        monitor.requestDrain();
        await monitor.waitForPumpIdle();
        expect(started).not.toContain("next");
        parked.resolve();
        await monitor.waitForIdle();
        expect(started).toContain("next");
      } finally {
        parked.resolve();
        await monitor.stop();
      }
    },
  );
});
