import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

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

describe("channel ingress monitor start capacity", () => {
  it("keeps claiming other lanes while deferred deliveries wait", async () => {
    const started: string[] = [];
    const parked = createDeferred();
    const monitor = createMonitor(
      async (raw, lifecycle) => {
        started.push(raw.id);
        if (raw.id === "event-unrelated") {
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
      await monitor.admit({ id: "event-parked-a", lane: "a", text: "a" });
      await monitor.admit({ id: "event-parked-b", lane: "b", text: "b" });
      await monitor.waitForPumpIdle();
      expect(started).toEqual(["event-parked-a", "event-parked-b"]);

      await monitor.admit({ id: "event-unrelated", lane: "c", text: "c" });
      await monitor.waitForPumpIdle();
      expect(started).toContain("event-unrelated");
    } finally {
      parked.resolve();
      await monitor.stop();
    }
  });

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
