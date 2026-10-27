import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import {
  createChannelIngressDrain,
  type CreateChannelIngressDrainOptions,
} from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

function createAdoptingDrain(
  queue: CreateChannelIngressDrainOptions<Payload>["queue"],
  currentNow: number,
) {
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
  return { drain, dispatches };
}

type Queue = ReturnType<typeof createTestIngressQueue>;
const enqueue = (queue: Queue, id: string, laneKey = "same", receivedAt = 1, text = id) =>
  queue.enqueue(id, { text }, { laneKey, receivedAt });
async function drainIdle(drain: ReturnType<typeof createChannelIngressDrain<Payload>>) {
  await drain.drainOnce();
  await drain.waitForIdle();
}

describe("channel ingress drain lanes", () => {
  it("blocks active, peer-owned, and delayed lanes without ordering their keys", async () => {
    await withTempState(async (stateDir) => {
      const currentNow = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => currentNow });
      const dispatches: string[] = [];
      const peer = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        dispatchClaimedEvent: () => ({ kind: "deferred" }),
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          if (event.id.startsWith("active-")) {
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return undefined;
        },
      });
      try {
        for (const id of ["peer-z", "peer-a"]) {
          await enqueue(queue, id, id);
        }
        await drainIdle(peer);
        for (const id of ["active-z", "active-a"]) {
          await enqueue(queue, id, id);
        }
        await drainIdle(drain);
        for (const id of ["delayed-z", "delayed-a"]) {
          await enqueue(queue, id, id);
          const claim = expectDefined(await queue.claim(id), "delayed claim");
          await queue.release(claim, { lastError: "retry", releasedAt: currentNow });
        }
        const blocked = ["peer-z", "peer-a", "active-z", "active-a", "delayed-z", "delayed-a"];
        for (const lane of blocked) {
          await enqueue(queue, `${lane}-tail`, lane, 2);
        }
        await enqueue(queue, "eligible", "eligible", 3);

        const compare = vi.spyOn(String.prototype, "localeCompare");
        let comparisons: number;
        try {
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
          comparisons = compare.mock.calls.length;
        } finally {
          compare.mockRestore();
        }

        expect(dispatches).toEqual(["active-a", "active-z", "eligible"]);
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(
          expect.arrayContaining(["peer-z", "peer-a", "active-z", "active-a"]),
        );
        expect((await queue.listPending()).map((row) => row.id)).toEqual(
          expect.arrayContaining([
            "delayed-z",
            "delayed-a",
            ...blocked.map((lane) => `${lane}-tail`),
          ]),
        );
        expect(comparisons).toBe(0);
      } finally {
        drain.dispose();
        peer.dispose();
      }
    });
  });

  it("keeps a competing head ahead of its tail while dispatching reconciled and retained lanes", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await enqueue(queue, "head", "same", 1, "same");
      await enqueue(queue, "tail", "same", 2, "same");
      await enqueue(queue, "other", "old-lane", 3);
      await enqueue(queue, "retained", "control", 4, "same");
      const listUnsettled = queue.listUnsettled!.bind(queue);
      const competing: { claim: Awaited<ReturnType<typeof queue.claim>> } = { claim: null };
      const listing = vi.spyOn(queue, "listUnsettled").mockImplementationOnce(async () => {
        const snapshot = await listUnsettled();
        competing.claim = await queue.claim("head", { ownerId: "competing-owner" });
        return snapshot;
      });
      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: (_record, stored) => stored === "old-lane",
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          if (event.id === "retained") {
            await lifecycle.onAdopted();
            return undefined;
          }
          return { kind: "deferred" };
        },
      });
      try {
        await drainIdle(drain);
        const competitor = expectDefined(competing.claim, "competing claim");
        expect(dispatches).toEqual(["other", "retained"]);
        expect(await enqueue(queue, "retained")).toMatchObject({ kind: "completed" });
        expect(await queue.listClaims()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "head", claim: competitor.claim }),
            expect.objectContaining({ id: "other", laneKey: "other" }),
          ]),
        );
        expect((await queue.listPending()).map((row) => row.id)).toEqual(["tail"]);
        await queue.complete(competitor);
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        expect(dispatches).toEqual(["other", "retained", "tail"]);
      } finally {
        drain.dispose();
        listing.mockRestore();
      }
    });
  });

  it.each(["received", "id"] as const)(
    "reads only unhanded same-lane backlog in %s order",
    async (orderBy) => {
      // State-worker admission must keep its immediate I/O turns while drain timers are held.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        await withTempState(async (stateDir) => {
          const currentNow = 10_000;
          const queue = createTestIngressQueue(stateDir, { now: () => currentNow });
          if (orderBy === "id") {
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
              await enqueue(queue, id, "lane", 1, "lane");
              await drainIdle(drain);
            }
            await enqueue(queue, "dispatching", "lane", 3, "lane");
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await enqueue(queue, "pending", "old-lane", 2, "lane");
            await enqueue(queue, "foreign", "lane", 4, "lane");
            expect(await queue.claim("foreign", { ownerId: "foreign-owner" })).not.toBeNull();
            await enqueue(queue, "other-lane", "other", 1, "lane");
            await enqueue(queue, "retry-delayed", "lane", 1, "lane");
            const retryClaim = expectDefined(await queue.claim("retry-delayed"), "retry claim");
            await queue.release(retryClaim, { lastError: "retry", releasedAt: currentNow });

            const readBacklog = expectDefined(
              lifecycles.get("self")?.readLaneBacklog,
              "self backlog",
            );
            const pendingBefore = await queue.listPending();
            const claimsBefore = await queue.listClaims();
            const expectedIds =
              orderBy === "received"
                ? ["pending", "dispatching", "foreign"]
                : ["dispatching", "foreign", "pending"];
            expect((await readBacklog()).map((row) => row.id)).toEqual(expectedIds);
            const readDispatchingBacklog = expectDefined(
              lifecycles.get("dispatching")?.readLaneBacklog,
              "dispatching backlog",
            );
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

  it.each([
    { delayed: "tail", expected: ["head"] },
    { delayed: "head", expected: [] },
  ])(
    "blocks only when the retry-delayed $delayed is the lane head",
    async ({ delayed, expected }) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        const currentNow = 10_000_000;
        await enqueue(queue, "head", "user:U1", 1_000);
        await enqueue(queue, "tail", "user:U1", 2_000);
        const claim = expectDefined(await queue.claim(delayed), "delayed claim");
        await queue.release(claim, { lastError: "boom", releasedAt: currentNow });
        const { drain, dispatches } = createAdoptingDrain(queue, currentNow);
        try {
          await expect(drain.drainOnce()).resolves.toEqual({ started: expected.length });
          await drain.waitForIdle();
          expect(dispatches).toEqual(expected);
        } finally {
          drain.dispose();
        }
      });
    },
  );

  it("keeps a released lane head ahead of its tail when settlement crosses the drain snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
      await enqueue(queue, "head");
      await enqueue(queue, "tail", "same", 2);
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
        const listUnsettled = expectDefined(queue.listUnsettled?.bind(queue), "list unsettled");
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
        await drainIdle(replacement);
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

  it.each([
    { failureOrder: "before deferral", releaseOutcome: "committed" },
    { failureOrder: "after deferral", releaseOutcome: "committed" },
    { failureOrder: "after deferral", releaseOutcome: "unknown" },
  ] as const)(
    "keeps a failed lane head ahead of its tail when release is $releaseOutcome ($failureOrder)",
    async ({ failureOrder, releaseOutcome }) => {
      await withTempState(async (stateDir) => {
        let clock = 10_000;
        const queue = createTestIngressQueue(stateDir, { now: () => clock });
        await enqueue(queue, "head");
        await enqueue(queue, "tail", "same", 2);
        const releaseStarted = createDeferredCore();
        const finishRelease = createDeferredCore();
        const releaseFailure = new SqliteWorkerError(
          "Synthetic lost release outcome",
          "outcome-unknown",
        );
        const release = queue.release.bind(queue);
        const heldRelease = vi.spyOn(queue, "release").mockImplementationOnce(async (...args) => {
          releaseStarted.resolve();
          await finishRelease.promise;
          if (releaseOutcome === "unknown") {
            throw releaseFailure;
          }
          return await release(...args);
        });
        let failure: Promise<void> | undefined;
        let settlementError: unknown;
        const dispatches: string[] = [];
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          deferredLaneOccupancy: "release",
          retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
          dispatchClaimedEvent: async (event, lifecycle) => {
            dispatches.push(event.id);
            if (event.id === "head" && !failure) {
              if (failureOrder === "after deferral") {
                lifecycle.onDeferred();
              }
              failure = Promise.resolve(
                expectDefined(lifecycle.onFailed, "failure callback")(new Error("retry head")),
              ).catch((error: unknown) => {
                settlementError = error;
              });
              await releaseStarted.promise;
              return { kind: "deferred" };
            }
            await lifecycle.onAdopted();
            return { kind: "completed" };
          },
        });
        try {
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
          await enqueue(queue, "other", "other", 3);
          await drainIdle(drain);
          expect(dispatches).toEqual(["head", "other"]);

          finishRelease.resolve();
          await failure;
          if (releaseOutcome === "unknown") {
            expect(settlementError).toBe(releaseFailure);
            await drainIdle(drain);
            expect(dispatches).toEqual(["head", "other"]);
            expect(await queue.listClaims()).toMatchObject([{ id: "head" }]);
            expect(await queue.listPending()).toMatchObject([{ id: "tail", attempts: 0 }]);
            return;
          }
          expect(settlementError).toBeUndefined();
          expect(await queue.listPending()).toMatchObject([
            { id: "head", attempts: 1, lastError: "retry head" },
            { id: "tail", attempts: 0 },
          ]);
          expect(await drain.drainOnce()).toEqual({ started: 0 });

          clock += 1_000;
          await drainIdle(drain);
          await drainIdle(drain);
          expect(dispatches).toEqual(["head", "other", "head", "tail"]);
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
        } finally {
          finishRelease.resolve();
          await failure;
          await drain.waitForIdle();
          drain.dispose();
          heldRelease.mockRestore();
        }
      });
    },
  );

  it("never claims a retry-delayed event whose lane head settled after the drain snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await enqueue(queue, "head", "user:U1", 1_000);
      await enqueue(queue, "tail", "user:U1", 2_000);
      const tailClaim = await queue.claim("tail");
      await queue.release(tailClaim!, { lastError: "boom", releasedAt: currentNow });

      // Snapshot keeps the eligible head, then a sibling drainer settles it. The
      // freed lane must not hand the still-delayed tail an early attempt.
      const snapshot = await queue.listUnsettled!({ orderBy: "received" });
      const headClaim = await queue.claim("head");
      expect(headClaim).not.toBeNull();
      await queue.complete(headClaim!);
      vi.spyOn(queue, "listUnsettled").mockResolvedValue(snapshot);

      const { drain, dispatches } = createAdoptingDrain(queue, currentNow);

      await expect(drain.drainOnce()).resolves.toEqual({ started: 0 });
      expect(dispatches).toEqual([]);

      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
