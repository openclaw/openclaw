import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("channel ingress monitor admission", () => {
  it.each(["direct", "wrapped"] as const)(
    "does not replay or acknowledge an append with a %s unknown native outcome",
    async (envelope) => {
      const queue = createChannelIngressQueue<StoredEvent>({
        channelId: "test",
        stateDir: tempDirs.make("openclaw-ingress-unknown-"),
      });
      const unknown = new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown");
      const failure =
        envelope === "direct"
          ? unknown
          : new Error("Synthetic cleanup failure", { cause: new AggregateError([unknown]) });
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
    },
  );

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
