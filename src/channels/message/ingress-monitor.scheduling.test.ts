import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  createMonitor,
  useIngressMonitorQueueFixture,
  type RawEvent,
} from "./ingress-monitor.test-harness.js";

const withQueue = useIngressMonitorQueueFixture();
const event: RawEvent = { id: "head", lane: "a", text: "synthetic" };

async function withTimedMonitor(
  run: (fixture: {
    queue: Parameters<Parameters<typeof withQueue>[0]>[0];
    monitor: ReturnType<typeof createMonitor>;
    deliver: ReturnType<typeof vi.fn<Parameters<typeof createMonitor>[1]>>;
    admit: (raw: RawEvent) => Promise<void>;
    advance: (ms: number) => Promise<void>;
  }) => Promise<void>,
  pollIntervalMs = 60_000,
) {
  await withQueue(async (queue) => {
    await queue.listPending();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const deliver = vi.fn<Parameters<typeof createMonitor>[1]>();
    const monitor = createMonitor(queue, deliver, { pollIntervalMs });
    try {
      monitor.start();
      await monitor.waitForIdle();
      await run({
        queue,
        monitor,
        deliver,
        admit: async (raw) => {
          await monitor.admit(raw);
          await monitor.waitForIdle();
        },
        advance: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
          await monitor.waitForIdle();
        },
      });
    } finally {
      await monitor.stop();
      vi.useRealTimers();
    }
  });
}

describe("ingress wake scheduling", () => {
  if (mixedAgentConnection) {
    useMixedAgentPair("postgres", "sqlite");
  }
  it("keeps an idle queue quiet and wakes immediately for durable admission", async () => {
    await withTimedMonitor(async ({ queue, deliver, admit, advance }) => {
      const scans = vi.spyOn(queue, "listUnsettled");
      const recoveries = vi.spyOn(queue, "recoverStaleClaims");
      await advance(299_999);
      expect(scans).not.toHaveBeenCalled();
      expect(recoveries).not.toHaveBeenCalled();

      await admit(event);
      expect(deliver).toHaveBeenCalledOnce();
      expect(recoveries).not.toHaveBeenCalled();
      expect(await queue.listPending()).toEqual([]);
    }, 1_000);
  });

  it("retries the lane head at its deadline without waiting for recovery", async () => {
    await withTimedMonitor(async ({ queue, deliver, admit, advance }) => {
      const delivered: string[] = [];
      let attempts = 0;
      deliver.mockImplementation(async (raw) => {
        delivered.push(raw.id);
        if (attempts++ === 0) {
          throw new Error("synthetic transient failure");
        }
      });
      await admit(event);
      await admit({ ...event, id: "tail" });
      expect(delivered).toEqual(["head"]);
      await advance(999);
      expect(delivered).toEqual(["head"]);
      await advance(1);
      expect(delivered).toEqual(["head", "head", "tail"]);
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it("retries a watchdog-released claim without waiting for recovery", async () => {
    await withTimedMonitor(async ({ queue, monitor, deliver, admit, advance }) => {
      let attempts = 0;
      const released = createDeferred();
      const release = queue.release.bind(queue);
      vi.spyOn(queue, "release").mockImplementation(async (...args) => {
        const result = await release(...args);
        released.resolve();
        return result;
      });
      deliver.mockImplementation(() => {
        if (attempts++ === 0) {
          return { kind: "deferred" };
        }
        return { kind: "completed" };
      });
      await admit(event);
      await vi.advanceTimersByTimeAsync(5_000);
      await released.promise;
      await monitor.waitForIdle();
      expect(attempts).toBe(1);
      await advance(1_000);
      expect(attempts).toBe(2);
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it("uses a freed delivery slot while other adopted deliveries are still running", async () => {
    await withQueue(async (queue) => {
      const releaseFirst = createDeferred();
      const releaseOthers = createDeferred();
      const batchStarted = createDeferred();
      const delivered: string[] = [];
      const monitor = createMonitor(
        queue,
        async (raw, lifecycle) => {
          await lifecycle.onAdopted();
          delivered.push(raw.id);
          if (delivered.length === 32) {
            batchStarted.resolve();
          }
          if (raw.id === "000") {
            await releaseFirst.promise;
          } else if (raw.id !== "032") {
            await releaseOthers.promise;
          }
        },
        { pollIntervalMs: 60_000 },
      );
      try {
        for (let index = 0; index < 33; index++) {
          const raw = { ...event, id: String(index).padStart(3, "0"), lane: String(index) };
          await queue.enqueue(
            raw.id,
            { version: 1, rawEvent: JSON.stringify(raw) },
            {
              laneKey: `lane:${raw.lane}`,
            },
          );
        }
        monitor.start();
        await batchStarted.promise;
        await monitor.waitForPumpIdle();
        expect(delivered).toHaveLength(32);
        releaseFirst.resolve();
        await vi.waitFor(() => expect(delivered).toContain("032"));
      } finally {
        releaseFirst.resolve();
        releaseOthers.resolve();
        await monitor.stop();
      }
    });
  });

  it.each(["external enqueue", "dead owner"])("recovers %s on the bounded sweep", async (kind) => {
    await withTimedMonitor(async ({ queue, deliver, advance }) => {
      await queue.enqueue(
        event.id,
        { version: 1, rawEvent: JSON.stringify(event) },
        { laneKey: "lane:a" },
      );
      const abandoned =
        kind === "dead owner"
          ? await queue.claim(event.id, { ownerId: "2147483647:0:dead" })
          : undefined;
      if (kind === "dead owner") {
        expect(abandoned).toBeDefined();
      }
      await advance(299_999);
      expect(deliver).not.toHaveBeenCalled();
      await advance(1);
      expect(deliver).toHaveBeenCalledOnce();
      expect(await queue.listClaims()).toEqual([]);
      if (abandoned) {
        expect(await queue.complete(abandoned)).toBe(false);
      }
    }, 1_000);
  });
});
