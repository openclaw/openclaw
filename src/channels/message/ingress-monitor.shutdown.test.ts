import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createMonitor,
  useIngressMonitorQueueFixture,
  waitForAbort,
} from "./ingress-monitor.test-harness.js";

const withQueue = useIngressMonitorQueueFixture();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("channel ingress monitor shutdown", () => {
  it("joins a settlement write before disposing the drain on stop", async () => {
    await withQueue(async (queue) => {
      const releaseStarted = createDeferredCore();
      const settlementGate = createDeferredCore();
      const release = queue.release.bind(queue);
      const order: string[] = [];
      const blockedRelease: typeof queue.release = async (idOrClaim, releaseOptions) => {
        releaseStarted.resolve();
        await settlementGate.promise;
        const result = await release(idOrClaim, releaseOptions);
        order.push("committed");
        return result;
      };
      queue.release = vi.fn(blockedRelease);
      const monitor = createMonitor(queue, async () => ({
        kind: "failed-retryable",
        error: new Error("retry later"),
      }));
      monitor.start();
      await monitor.admit({ id: "event-stop-settlement", lane: "a", text: "hello" });
      await releaseStarted.promise;

      const stopping = monitor.stop().then(() => order.push("stopped"));
      try {
        await monitor.waitForPumpIdle();
        settlementGate.resolve();
        await stopping;
        expect(order).toEqual(["committed", "stopped"]);
      } finally {
        settlementGate.resolve();
        await stopping;
      }
    });
  });

  it.each(
    (["cancel", "adopt", "completed", "failed"] as const).flatMap((settlementKind) =>
      [false, true].map((waitForDeliveryIdleOnStop) => ({
        settlementKind,
        waitForDeliveryIdleOnStop,
      })),
    ),
  )(
    "joins the $settlementKind write before disposal with delivery wait=$waitForDeliveryIdleOnStop",
    async ({ settlementKind, waitForDeliveryIdleOnStop }) => {
      await withQueue(async (queue) => {
        const started = createDeferredCore();
        const writeStarted = createDeferredCore();
        const commit = createDeferredCore();
        const order: string[] = [];
        const pauseWrite = async (write: () => Promise<boolean>) => {
          writeStarted.resolve();
          await commit.promise;
          const result = await write();
          order.push("committed");
          return result;
        };
        if (settlementKind === "cancel" || settlementKind === "failed") {
          const release = queue.release.bind(queue);
          vi.spyOn(queue, "release").mockImplementation((...args) =>
            pauseWrite(() => release(...args)),
          );
        } else {
          const complete = queue.complete.bind(queue);
          vi.spyOn(queue, "complete").mockImplementation((...args) =>
            pauseWrite(() => complete(...args)),
          );
        }
        let settlement = Promise.resolve();
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            started.resolve();
            if (settlementKind === "completed") {
              return { kind: "completed" };
            }
            if (settlementKind === "failed") {
              return { kind: "failed-retryable", error: new Error("retry delivery") };
            }
            await waitForAbort(lifecycle.abortSignal);
            settlement = Promise.resolve(
              settlementKind === "cancel" ? lifecycle.onCancelled?.() : lifecycle.onAdopted(),
            );
            return { kind: settlementKind === "cancel" ? "deferred" : "completed" };
          },
          { deferredClaims: "wait-on-stop", waitForDeliveryIdleOnStop },
        );
        monitor.start();
        await monitor.admit({ id: "inline-settlement", lane: "a", text: "hello" });
        await started.promise;
        if (settlementKind === "completed" || settlementKind === "failed") {
          await writeStarted.promise;
        }
        const stopping = monitor.stop().then(() => order.push("stopped"));
        const successor = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (_claim, lifecycle) => {
            await lifecycle.onAdopted();
          },
        });
        try {
          await writeStarted.promise;
          await monitor.waitForPumpIdle();
          expect(await successor.drainOnce()).toEqual({ started: 0 });
          commit.resolve();
          await Promise.all([settlement, stopping]);
          expect(order).toEqual(["committed", "stopped"]);
          expect(await queue.listClaims()).toEqual([]);
          expect((await queue.listPending()).map((row) => row.id)).toEqual(
            settlementKind === "cancel" || settlementKind === "failed" ? ["inline-settlement"] : [],
          );
        } finally {
          commit.resolve();
          await Promise.allSettled([settlement, stopping]);
          await successor.waitForIdle();
          successor.dispose();
        }
      });
    },
  );
});
