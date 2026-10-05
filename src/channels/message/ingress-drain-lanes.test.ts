import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  combineIngressAdmissionTurns,
  type ChannelIngressDispatchLifecycle,
} from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain lanes", () => {
  it.each<{
    orderBy: "received" | "id";
    coherentSnapshot: boolean;
    expectedIds: string[];
  }>([
    {
      orderBy: "received",
      coherentSnapshot: true,
      expectedIds: ["pending", "dispatching", "foreign"],
    },
    {
      orderBy: "id",
      coherentSnapshot: false,
      expectedIds: ["dispatching", "foreign", "pending"],
    },
  ])(
    "reads only unhanded same-lane backlog in $orderBy order (coherent snapshot: $coherentSnapshot)",
    async ({ orderBy, coherentSnapshot, expectedIds }) => {
      // State-worker admission must keep its immediate I/O turns while drain timers are held.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        await withTempState(async (stateDir) => {
          const currentNow = 10_000;
          const queue = createTestIngressQueue(stateDir, { now: () => currentNow });
          if (!coherentSnapshot) {
            queue.listUnsettled = undefined;
          }
          const finishDispatch = createDeferredCore();
          const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
          const drain = createChannelIngressDrain<Payload>({
            queue,
            now: () => currentNow,
            orderBy,
            deferredLaneOccupancy: "release",
            deriveLaneKey: (row) => row.payload.text,
            reconcileStoredLaneKey: (_row, storedLaneKey) => storedLaneKey === "old-lane",
            retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
            dispatchClaimedEvent: async (event, lifecycle) => {
              lifecycles.set(event.id, lifecycle);
              if (event.id === "dispatching") {
                await finishDispatch.promise;
                await lifecycle.onAdopted();
                return { kind: "completed" };
              }
              return { kind: "deferred" };
            },
          });
          try {
            for (const id of ["released", "self"]) {
              await queue.enqueue(id, { text: "lane" }, { laneKey: "lane", receivedAt: 1 });
              expect(await drain.drainOnce()).toEqual({ started: 1 });
              await drain.waitForIdle();
            }
            await queue.enqueue(
              "dispatching",
              { text: "lane" },
              { laneKey: "lane", receivedAt: 3 },
            );
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await queue.enqueue(
              "pending",
              { text: "lane" },
              { laneKey: "old-lane", receivedAt: 2 },
            );
            await queue.enqueue("foreign", { text: "lane" }, { laneKey: "lane", receivedAt: 4 });
            expect(await queue.claim("foreign", { ownerId: "foreign-owner" })).not.toBeNull();
            await queue.enqueue("other-lane", { text: "lane" }, { laneKey: "other" });
            await queue.enqueue("retry-delayed", { text: "lane" }, { laneKey: "lane" });
            const retryClaim = await queue.claim("retry-delayed");
            if (!retryClaim) {
              throw new Error("Expected retry fixture claim");
            }
            await queue.release(retryClaim, { lastError: "retry", releasedAt: currentNow });

            const readBacklog = lifecycles.get("self")?.readLaneBacklog;
            if (!readBacklog) {
              throw new Error("Expected drain lifecycle lane backlog reader");
            }
            const pendingBefore = await queue.listPending();
            const claimsBefore = await queue.listClaims();
            expect((await readBacklog()).map((row) => row.id)).toEqual(expectedIds);
            const readDispatchingBacklog = lifecycles.get("dispatching")?.readLaneBacklog;
            if (!readDispatchingBacklog) {
              throw new Error("Expected dispatching lifecycle lane backlog reader");
            }
            expect((await readDispatchingBacklog()).map((row) => row.id)).toEqual(
              expectedIds.filter((id) => id !== "dispatching"),
            );
            expect(await queue.listPending()).toEqual(pendingBefore);
            expect(await queue.listClaims()).toEqual(claimsBefore);
            expect(drain.activeLaneKeys()).toEqual(new Set(["lane"]));
          } finally {
            finishDispatch.resolve();
            await drain.waitForIdle();
            drain.dispose();
          }
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves rejected stored lanes and attempts each snapshot candidate once", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("active", { text: "topic" }, { laneKey: "topic" });
      let releaseActive: (() => void) | undefined;
      const activeDone = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: () => false,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          if (event.id === "active") {
            await activeDone;
          }
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active"]));
      await queue.enqueue("candidate", { text: "topic" }, { laneKey: "control" });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active", "candidate"]));
      await expect(queue.enqueue("candidate", { text: "topic" })).resolves.toMatchObject({
        kind: "completed",
      });

      releaseActive?.();
      await drain.waitForIdle();
      drain.dispose();
    });
  });

  // LINE-shaped lanes: one user/group id owns a lane, so a lane head parked behind
  // a newer failing sibling reads to the sender as an ignored message.
  it("starts an eligible lane head while a newer same-lane event waits out its retry backoff", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const tailClaim = await queue.claim("tail");
      expect(tailClaim).not.toBeNull();
      await queue.release(tailClaim!, { lastError: "boom", releasedAt: currentNow });

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["head"]));

      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("keeps the lane blocked while its oldest pending event is retry-delayed", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const headClaim = await queue.claim("head");
      expect(headClaim).not.toBeNull();
      await queue.release(headClaim!, { lastError: "boom", releasedAt: currentNow });

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 0 });
      expect(dispatches).toEqual([]);

      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("keeps a released lane head ahead of its tail when settlement crosses the drain snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
      await queue.enqueue("head", { text: "head" }, { laneKey: "same", receivedAt: 1 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "same", receivedAt: 2 });
      const started = createDeferredCore();
      const failHead = createDeferredCore();
      const dispatches: string[] = [];
      const first = createChannelIngressDrain<Payload>({
        queue,
        now: () => 10_000,
        dispatchClaimedEvent: async (event) => {
          dispatches.push(event.id);
          started.resolve();
          await failHead.promise;
          return { kind: "failed-retryable", error: new Error("retry head") };
        },
      });
      const replacement = createChannelIngressDrain<Payload>({
        queue,
        now: () => 10_000,
        retryPolicy: { baseMs: 0, maxMs: 0 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });
      try {
        expect(await first.drainOnce()).toEqual({ started: 1 });
        await started.promise;
        const afterSnapshot = async <T>(read: Promise<T>): Promise<T> => {
          const snapshot = await read;
          failHead.resolve();
          await first.waitForIdle();
          return snapshot;
        };
        const listPending = queue.listPending.bind(queue);
        if (!queue.listUnsettled) {
          throw new Error("Expected the core queue's unsettled snapshot reader");
        }
        const listUnsettled = queue.listUnsettled.bind(queue);
        // The split-read negative control loses the head between these same boundaries.
        vi.spyOn(queue, "listPending").mockImplementationOnce((options) =>
          afterSnapshot(listPending(options)),
        );
        vi.spyOn(queue, "listUnsettled").mockImplementationOnce((options) =>
          afterSnapshot(listUnsettled(options)),
        );

        expect(await replacement.drainOnce()).toEqual({ started: 0 });
        expect(dispatches).toEqual(["head"]);
        expect(await replacement.drainOnce()).toEqual({ started: 1 });
        await replacement.waitForIdle();
        expect(dispatches).toEqual(["head", "head"]);
        expect(await replacement.drainOnce()).toEqual({ started: 1 });
        await replacement.waitForIdle();
        expect(dispatches).toEqual(["head", "head", "tail"]);
      } finally {
        failHead.resolve();
        await Promise.allSettled([first.waitForIdle(), replacement.waitForIdle()]);
        first.dispose();
        replacement.dispose();
        vi.restoreAllMocks();
      }
    });
  });

  it("never claims a retry-delayed event whose lane head settled after the drain snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const tailClaim = await queue.claim("tail");
      await queue.release(tailClaim!, { lastError: "boom", releasedAt: currentNow });

      // Snapshot keeps the eligible head, then a sibling drainer settles it. The
      // freed lane must not hand the still-delayed tail an early attempt.
      const snapshot = await queue.listUnsettled!({ orderBy: "received" });
      const headClaim = await queue.claim("head");
      expect(headClaim).not.toBeNull();
      await queue.complete(headClaim!);
      vi.spyOn(queue, "listUnsettled").mockResolvedValue(snapshot);

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 0 });
      expect(dispatches).toEqual([]);

      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("keeps a buffered claim's reply admission ahead of a later sender on its released lane", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      const order: string[] = [];
      let laterSenderAdmitted: Promise<void> | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        deriveLaneKey: () => "chat",
        dispatchClaimedEvent: (event, lifecycle) => {
          lifecycles.set(event.id, lifecycle);
          if (event.id === "other-sender") {
            // A different debounce key flushes on its own timer.
            laterSenderAdmitted = lifecycle.admissionTurn?.wait().then(() => {
              order.push("other-sender");
              lifecycle.onDeferred();
            });
          }
          // Every claim is still buffered when dispatch returns.
          return { kind: "deferred" };
        },
      });
      try {
        for (const [index, id] of ["first", "other-sender", "same-sender"].entries()) {
          await queue.enqueue(id, { text: id }, { receivedAt: index });
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
        }
        const first = lifecycles.get("first");
        const sameSender = lifecycles.get("same-sender");
        if (!first || !sameSender || !laterSenderAdmitted) {
          throw new Error("Expected every claim to reach its channel buffer");
        }

        // The coalesced batch never waits on the sender that arrived between its members.
        await combineIngressAdmissionTurns([first.admissionTurn, sameSender.admissionTurn])?.wait();
        order.push("batch");
        // Queued reply admission, not adoption, releases the later sender.
        first.onDeferred();
        sameSender.onDeferred();
        await laterSenderAdmitted;

        expect(order).toEqual(["batch", "other-sender"]);
        expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual([
          "first",
          "other-sender",
          "same-sender",
        ]);
      } finally {
        drain.dispose();
      }
    });
  });

  it("replays a claim waiting on its admission turn in order after the drain shuts down", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      let interruptedWait: Promise<boolean> | undefined;
      const shutDown = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        deriveLaneKey: () => "chat",
        dispatchClaimedEvent: (event, lifecycle) => {
          if (event.id === "later") {
            interruptedWait = lifecycle.admissionTurn
              ?.wait()
              .then(() => lifecycle.abortSignal.aborted);
          }
          return { kind: "deferred" };
        },
      });
      for (const [index, id] of ["earlier", "later"].entries()) {
        await queue.enqueue(id, { text: id }, { receivedAt: index });
        expect(await shutDown.drainOnce()).toEqual({ started: 1 });
        await shutDown.waitForIdle();
      }
      shutDown.dispose();
      // Shutdown, not admission, ended the wait; both claims stay held for recovery.
      expect(await interruptedWait).toBe(true);
      expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual([
        "earlier",
        "later",
      ]);

      const order: string[] = [];
      let earlier: ChannelIngressDispatchLifecycle | undefined;
      let laterAdmitted: Promise<void> | undefined;
      const replay = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        deriveLaneKey: () => "chat",
        dispatchClaimedEvent: (event, lifecycle) => {
          if (event.id === "earlier") {
            earlier = lifecycle;
          } else {
            laterAdmitted = lifecycle.admissionTurn?.wait().then(async () => {
              order.push("later");
              await lifecycle.onAdopted();
            });
          }
          return { kind: "deferred" };
        },
      });
      try {
        expect(await replay.drainOnce()).toEqual({ started: 1 });
        await replay.waitForIdle();
        expect(await replay.drainOnce()).toEqual({ started: 1 });
        await replay.waitForIdle();
        if (!earlier || !laterAdmitted) {
          throw new Error("Expected both recovered claims to reach their channel buffers");
        }
        order.push("earlier");
        await earlier.onAdopted();
        await laterAdmitted;

        expect(order).toEqual(["earlier", "later"]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        replay.dispose();
      }
    });
  });
});
