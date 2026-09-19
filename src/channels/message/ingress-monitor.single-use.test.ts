import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";
import { ChannelIngressUnavailableError } from "./ingress-unavailable.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function createMonitor(queue: ChannelIngressQueue<StoredEvent>) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
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
    drain: { adoptionStallTimeoutMs: 5_000, retryPolicy: { baseMs: 1_000, maxMs: 1_000 } },
  });
}

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-single-use-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

describe("channel ingress monitor single-use contract", () => {
  it("throws instead of silently no-oping when started after stop", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue);
      monitor.start();
      await monitor.stop();

      expect(() => monitor.start()).toThrowError(ChannelIngressUnavailableError);
      expect(() => monitor.start()).toThrowError(/stopped/i);
      expect(monitor.isStopped()).toBe(true);
      await expect(monitor.admit({ id: "after-stop", lane: "a", text: "hello" })).rejects.toThrow(
        /stopped/i,
      );
    });
  });

  it("keeps repeated start calls idempotent while running", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue);
      monitor.start();
      expect(() => monitor.start()).not.toThrow();
      await monitor.stop();
    });
  });
});
