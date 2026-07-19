import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

class PermanentIngressError extends Error {}

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(
  queue: ChannelIngressQueue<StoredEvent>,
  deliver: (raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => Promise<void> | void,
  onActivityChange?: (active: boolean) => void,
  onError?: (error: unknown) => void,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new PermanentIngressError(kind),
    },
    deliver,
    pollIntervalMs: 10,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      resolveNonRetryableFailure: (error) =>
        error instanceof PermanentIngressError
          ? { reason: "invalid-event", message: error.message }
          : null,
    },
    ...(onActivityChange ? { onActivityChange } : {}),
    ...(onError ? { onError } : {}),
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channel ingress monitor", () => {
  it("adopts terminal no-dispatch events", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, vi.fn());
      monitor.start();
      await expect(
        monitor.admit({ id: "event-terminal", lane: "a", text: "ignored" }),
      ).resolves.toEqual({ kind: "durable" });
      await monitor.waitForIdle();

      await expect(
        queue.enqueue("event-terminal", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("fans adoption finalization through before completing the claim", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onAdoptionFinalizing();
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-finalizing", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await expect(
        queue.enqueue("event-finalizing", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("dead-letters a claim whose decoded lane identity changed", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "event-original",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "event-original", lane: "changed", text: "hello" }),
        },
        { laneKey: "lane:original" },
      );
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      await expect(
        queue.enqueue("event-original", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "failed", record: { reason: "invalid-event" } });
      await monitor.stop();
    });
  });

  it("rechecks identity against a derived lane for legacy rows", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue("event-derived", {
        version: 1,
        rawEvent: JSON.stringify({ id: "event-derived", lane: "a", text: "hello" }),
      });
      const deliver = vi.fn();
      const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
        queue,
        inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
        payload: {
          storage: "raw-event",
          version: 1,
          serialize: (raw) => JSON.stringify(raw),
          deserialize: (body) => JSON.parse(body) as RawEvent,
          createClaimError: (kind) => new PermanentIngressError(kind),
        },
        deliver,
        pollIntervalMs: 10,
        retention: { pruneIntervalMs: 60_000 },
        drain: {
          deriveLaneKey: () => "lane:a",
          resolveNonRetryableFailure: (error) =>
            error instanceof PermanentIngressError
              ? { reason: "invalid-event", message: error.message }
              : null,
        },
      });
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });

  it("drains a newly admitted unrelated lane while another delivery is active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        if (raw.id === "event-first") {
          await firstDone;
        }
        await lifecycle.onAdopted();
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "b", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("drains the next same-lane event after adoption while delivery remains active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        await lifecycle.onAdopted();
        if (raw.id === "event-first") {
          await firstDone;
        }
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "a", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("reports active delivery work until the channel callback settles", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery: (() => void) | undefined;
      const deliveryDone = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const activity: boolean[] = [];
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          await lifecycle.onAdopted();
          await deliveryDone;
        },
        (active) => activity.push(active),
      );
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;

      await monitor.admit({ id: "event-active", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(activity).toContain(true));
      expect(activity.at(-1)).toBe(true);

      releaseDelivery?.();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
      await monitor.stop();
    });
  });

  it("isolates activity observer failures from delivery bookkeeping", async () => {
    await withQueue(async (queue) => {
      const observerError = new Error("observer failed");
      const onError = vi.fn();
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(
        queue,
        deliver,
        () => {
          throw observerError;
        },
        onError,
      );
      monitor.start();

      await monitor.admit({ id: "event-observer", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(observerError);
      await monitor.stop();
    });
  });
});
