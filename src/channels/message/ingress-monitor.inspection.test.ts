import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

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

describe("channel ingress monitor asynchronous inspection", () => {
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

  it.each(["deliver", "cancel", "reject"] as const)(
    "reports busy through inspection until %s",
    async (outcome) => {
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
            if (outcome === "reject") {
              throw new Error("inspection failed");
            }
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
        const stopping = outcome === "cancel" ? monitor.stop() : undefined;
        release.resolve();
        await stopping;
        await monitor.waitForIdle();
        expect(activity.at(-1)).toBe(false);
        expect(deliver).toHaveBeenCalledTimes(outcome === "deliver" ? 1 : 0);
      } finally {
        release.resolve();
        await monitor.stop();
      }
    },
  );

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

  it("rejects a changed awaited claim identity", async () => {
    const queue = createQueue();
    const deliver = vi.fn();
    const monitor = createMonitor(queue, {
      inspectAsync: async (raw, context) => ({
        eventId: raw.id,
        laneKey: context.phase === "claim" ? "changed" : raw.lane,
      }),
      deliver,
    });
    try {
      await monitor.admit({ id: "identity", lane: "a" });
      monitor.start();
      await monitor.waitForIdle();
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
