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

describe("ingress wake scheduling", () => {
  if (mixedAgentConnection) {
    useMixedAgentPair("postgres", "sqlite");
  }
  it("keeps an idle queue quiet and wakes immediately for durable admission", async () => {
    await withQueue(async (queue) => {
      await queue.listPending();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const scans = vi.spyOn(queue, "listUnsettled");
      const recoveries = vi.spyOn(queue, "recoverStaleClaims");
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver, { pollIntervalMs: 1_000 });
      try {
        monitor.start();
        await monitor.waitForIdle();
        scans.mockClear();
        recoveries.mockClear();
        await vi.advanceTimersByTimeAsync(59_999);
        await monitor.waitForIdle();
        expect(scans).not.toHaveBeenCalled();
        expect(recoveries).not.toHaveBeenCalled();

        await monitor.admit(event);
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
        expect(recoveries).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([]);
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("retries the lane head at its deadline without waiting for recovery", async () => {
    await withQueue(async (queue) => {
      await queue.listPending();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const delivered: string[] = [];
      let attempts = 0;
      const monitor = createMonitor(
        queue,
        async (raw) => {
          delivered.push(raw.id);
          if (attempts++ === 0) {
            throw new Error("synthetic transient failure");
          }
        },
        { pollIntervalMs: 60_000 },
      );
      try {
        monitor.start();
        await monitor.waitForIdle();
        await monitor.admit(event);
        await monitor.waitForIdle();
        await monitor.admit({ ...event, id: "tail" });
        await monitor.waitForIdle();
        expect(delivered).toEqual(["head"]);
        await vi.advanceTimersByTimeAsync(999);
        expect(delivered).toEqual(["head"]);
        await vi.advanceTimersByTimeAsync(1);
        await monitor.waitForIdle();
        expect(delivered).toEqual(["head", "head", "tail"]);
        expect(await queue.listPending()).toEqual([]);
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("retries a watchdog-released claim without waiting for recovery", async () => {
    await withQueue(async (queue) => {
      await queue.listPending();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      let attempts = 0;
      const released = createDeferred();
      const release = queue.release.bind(queue);
      vi.spyOn(queue, "release").mockImplementation(async (...args) => {
        const result = await release(...args);
        released.resolve();
        return result;
      });
      const monitor = createMonitor(
        queue,
        () => {
          if (attempts++ === 0) {
            return { kind: "deferred" };
          }
          return { kind: "completed" };
        },
        { pollIntervalMs: 60_000 },
      );
      try {
        monitor.start();
        await monitor.waitForIdle();
        await monitor.admit(event);
        await monitor.waitForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await released.promise;
        await monitor.waitForIdle();
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        await monitor.waitForIdle();
        expect(attempts).toBe(2);
        expect(await queue.listPending()).toEqual([]);
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
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

  it("recovers a dead owner's claim on the bounded sweep", async () => {
    await withQueue(async (queue) => {
      await queue.listPending();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver, { pollIntervalMs: 1_000 });
      try {
        monitor.start();
        await monitor.waitForIdle();
        await queue.enqueue(
          event.id,
          { version: 1, rawEvent: JSON.stringify(event) },
          { laneKey: "lane:a" },
        );
        const abandoned = await queue.claim(event.id, { ownerId: "2147483647:0:dead" });
        expect(abandoned).toBeDefined();
        await vi.advanceTimersByTimeAsync(60_000);
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.complete(abandoned!)).toBe(false);
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });
});
