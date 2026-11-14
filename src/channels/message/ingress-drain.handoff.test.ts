import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import { createMonitor, useIngressMonitorQueueFixture } from "./ingress-monitor.test-harness.js";

const withQueue = useIngressMonitorQueueFixture();

describe("durable ingress downstream handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });
  it.each(["pending", "queue-cap-old", "queue-cap-new"] as const)(
    "preserves the durable disposition for %s across repeated drains",
    async (outcome) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("capacity-pending", { text: "wait for capacity" }, { receivedAt: 1 });
        const dispatch = vi.fn<
          Parameters<typeof createChannelIngressDrain<Payload>>[0]["dispatchClaimedEvent"]
        >(async (_claim, lifecycle) => {
          if (outcome === "pending") {
            return { kind: "pending" };
          }
          await lifecycle.onDropped?.(outcome);
          return { kind: "deferred" };
        });
        const onDeadLetter = vi.fn();
        const onLog = vi.fn();
        const drain = createChannelIngressDrain<Payload>({
          queue,
          onDeadLetter,
          onLog,
          dispatchClaimedEvent: dispatch,
          retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        });
        try {
          for (let pass = 0; pass < 3; pass += 1) {
            expect(await drain.drainOnce()).toEqual({
              started: outcome === "pending" || pass === 0 ? 1 : 0,
            });
            await drain.waitForIdle();
            expect(await queue.listPending()).toMatchObject(
              outcome === "pending"
                ? [{ id: "capacity-pending", attempts: 0, payload: { text: "wait for capacity" } }]
                : [],
            );
            expect(await queue.listClaims()).toEqual([]);
          }
          expect(dispatch).toHaveBeenCalledTimes(outcome === "pending" ? 3 : 1);
          expect(onDeadLetter).not.toHaveBeenCalled();
          expect(onLog.mock.calls.flat().join(" ")).not.toMatch(/failed after|dead-lettered/);
          expect(await queue.listFailed?.()).toMatchObject(
            outcome === "pending" ? [] : [{ id: "capacity-pending", reason: outcome }],
          );
        } finally {
          drain.dispose();
        }
      });
    },
  );

  it("accepts an atomic downstream receipt transfer without a second completion even after abort", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const complete = vi.spyOn(queue, "complete");
      const controller = new AbortController();
      await queue.enqueue("transferred", { text: "receipt-owned" });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        abortSignal: controller.signal,
        dispatchClaimedEvent: async (claim) => {
          expect(await queue.complete(claim)).toBe(true);
          controller.abort();
          return { kind: "transferred" };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(complete).toHaveBeenCalledOnce();
        expect(await queue.enqueue("transferred", { text: "retry" })).toMatchObject({
          kind: "completed",
        });
        expect(drain.activeLaneKeys().size).toBe(0);
      } finally {
        drain.dispose();
      }
    });
  });
  it("stops and restarts a monitor after one failed cancellation release without replaying adopted work", async () => {
    await withQueue(async (queue) => {
      const firstFailure = createDeferredCore();
      const cancelled = createDeferredCore();
      const adopted: string[] = [];
      const old = createMonitor(queue, async (raw, lifecycle) => {
        if (raw.id === "task") {
          lifecycle.onDeferred();
          lifecycle.abortSignal.addEventListener(
            "abort",
            () => {
              cancelled.resolve(lifecycle.onCancelled?.());
            },
            { once: true },
          );
          return { kind: "deferred" };
        }
        await lifecycle.onAdopted();
        adopted.push(raw.id);
        return { kind: "completed" };
      });
      const newer = createMonitor(queue, async (raw, lifecycle, claim) => {
        if (raw.id === "task") {
          expect(claim.claim.token).not.toBe(original!.claim.token);
          await expect(queue.release(original!)).resolves.toBe(false);
          await expect(queue.complete(original!)).resolves.toBe(false);
          await expect(queue.refreshClaim!(original!)).resolves.toBe(false);
        }
        await lifecycle.onAdopted();
        adopted.push(raw.id);
      });
      let original: Awaited<ReturnType<typeof queue.listClaims>>[number] | undefined;
      try {
        old.start();
        await old.admit({ id: "task", lane: "a", text: "task" });
        await old.waitForIdle();
        await old.admit({ id: "waiting", lane: "a", text: "waiting" });
        await old.admit({ id: "unrelated", lane: "b", text: "done" });
        await old.waitForIdle();
        [original] = await queue.listClaims();
        expect(original?.id).toBe("task");
        const release = vi.spyOn(queue, "release").mockImplementationOnce(async () => {
          firstFailure.resolve();
          throw new Error("Synthetic known release failure before native write");
        });
        const stopped = old.stop().then(
          () => undefined,
          (error: unknown) => error,
        );
        await firstFailure.promise;
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await stopped).toBeUndefined();
        await cancelled.promise;
        expect(release).toHaveBeenCalledTimes(2);
        expect(await queue.listClaims()).toEqual([]);
        expect((await queue.listPending()).map((row) => [row.id, row.attempts])).toEqual([
          ["task", 0],
          ["waiting", 0],
        ]);
        newer.start();
        await newer.waitForIdle();
        expect(adopted).toEqual(["unrelated", "task", "waiting"]);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(
          await queue.enqueue("unrelated", { version: 1, rawEvent: "duplicate" }),
        ).toMatchObject({ kind: "completed" });
      } finally {
        await old.stop().catch(() => {});
        await cancelled.promise.catch(() => {});
        await newer.stop();
      }
    });
  });
  it.each([
    "exhausted",
    "cause",
    "aggregate",
    "disposed",
    "reclaimed",
    "standalone",
    "abandoned",
  ] as const)("preserves cancellation custody and retry bounds for %s", async (mode) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("held", { text: "pending" }, { laneKey: "lane" });
      const abort = new AbortController();
      let lifecycle: ChannelIngressDispatchLifecycle | undefined;
      const log = vi.fn();
      const drain = createChannelIngressDrain(
        {
          queue,
          abortSignal: abort.signal,
          onLog: log,
          dispatchClaimedEvent: (_event, owner) => {
            lifecycle = owner;
            owner.onDeferred();
            return { kind: "deferred" };
          },
        },
        mode !== "standalone",
      );
      const peer = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: (_event, owner) => {
          owner.onDeferred();
          return { kind: "deferred" };
        },
      });
      const unknown = new SqliteWorkerError("Synthetic uncertain release", "outcome-unknown");
      const failure =
        mode === "cause" || mode === "aggregate"
          ? new Error("Synthetic release failure", {
              cause: mode === "cause" ? unknown : new AggregateError([unknown]),
            })
          : new Error("Synthetic known release failure");
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        if (!lifecycle?.onCancelled) {
          throw new Error("Expected a deferred cancellation owner");
        }
        const original = await queue.listClaims();
        abort.abort();
        const nativeRelease = queue.release.bind(queue);
        const release = vi.spyOn(queue, "release");
        if (mode === "reclaimed") {
          release.mockRejectedValueOnce(failure);
        } else {
          release.mockRejectedValue(failure);
        }
        const cancellation =
          mode === "abandoned" ? lifecycle.onAbandoned() : lifecycle.onCancelled();
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "disposed") {
          drain.dispose();
        }
        let successor: typeof original | undefined;
        if (mode === "reclaimed") {
          await nativeRelease(original[0]!, { recordAttempt: false });
          await peer.drainOnce();
          await peer.waitForIdle();
          successor = await queue.listClaims();
          expect(successor[0]?.claim.token).not.toBe(original[0]?.claim.token);
        }
        await vi.advanceTimersByTimeAsync(3_000);
        await cancellation;
        expect(release).toHaveBeenCalledTimes(
          mode === "exhausted" ? 3 : mode === "reclaimed" ? 2 : 1,
        );
        if (mode === "exhausted") {
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining("after 3 attempt(s); holding claim"),
          );
        }
        if (mode === "cause" || mode === "aggregate" || mode === "exhausted") {
          expect(log).toHaveBeenCalledWith(expect.stringContaining("holding claim"));
          await expect(drain.dispose({ waitForSettlements: true })).rejects.toBe(failure);
          expect(await peer.recoverStaleClaims()).toBe(mode === "exhausted" ? 1 : 0);
          expect(await queue.listPending()).toMatchObject(
            mode === "exhausted" ? [{ id: "held", attempts: 0 }] : [],
          );
        }
        if (mode === "reclaimed") {
          await drain.dispose({ waitForSettlements: true });
        }
        expect((await queue.listClaims()).map((row) => row.claim.token)).toEqual(
          (mode === "exhausted" ? [] : (successor ?? original)).map((row) => row.claim.token),
        );
      } finally {
        abort.abort();
        drain.dispose();
        peer.dispose();
      }
    });
  });
});
