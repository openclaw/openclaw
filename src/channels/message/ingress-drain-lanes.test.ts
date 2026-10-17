import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withDrainFixture } from "./ingress-drain-suite.test-support.js";

const drainIt = (name: string, run: Parameters<typeof withDrainFixture<void>>[0]) =>
  it(name, () => withDrainFixture(run));

describe("channel ingress drain lanes", () => {
  drainIt(
    "keeps a competing lane head ahead of its tail while dispatching other lanes",
    async ({ queue, enqueue, createDrain, dispatches }) => {
      await enqueue("head", "same", "same", 1);
      await enqueue("tail", "same", "same", 2);
      await enqueue("other", "other", "old-lane", 3);
      const listUnsettled = queue.listUnsettled!.bind(queue);
      const competing: { claim: Awaited<ReturnType<typeof queue.claim>> } = { claim: null };
      const listing = vi.spyOn(queue, "listUnsettled").mockImplementationOnce(async () => {
        const snapshot = await listUnsettled();
        competing.claim = await queue.claim("head", { ownerId: "competing-owner" });
        return snapshot;
      });

      const drain = createDrain({
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: (_record, stored) => stored === "old-lane",
        dispatchClaimedEvent: () => ({ kind: "deferred" }),
      });
      try {
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        const competitor = expectDefined(competing.claim, "competing claim");
        expect(dispatches).toEqual(["other"]);
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
        expect(dispatches).toEqual(["other", "tail"]);
      } finally {
        drain.dispose();
        listing.mockRestore();
      }
    },
  );

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
        const currentNow = 10_000;
        await withDrainFixture(
          async ({ queue, enqueue, createDrain, byId: lifecycles }) => {
            if (!coherentSnapshot) {
              queue.listUnsettled = undefined;
            }
            const finishDispatch = createDeferredCore();

            const drain = createDrain({
              orderBy,
              deferredLaneOccupancy: "release",
              deriveLaneKey: (row) => row.payload.text,
              reconcileStoredLaneKey: (_row, storedLaneKey) => storedLaneKey === "old-lane",
              retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
              dispatchClaimedEvent: async (event, lifecycle) => {
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
                await enqueue(id, "lane", "lane", 1);
                expect(await drain.drainOnce()).toEqual({ started: 1 });
                await drain.waitForIdle();
              }
              await enqueue("dispatching", "lane", "lane", 3);
              expect(await drain.drainOnce()).toEqual({ started: 1 });
              await enqueue("pending", "lane", "old-lane", 2);
              await enqueue("foreign", "lane", "lane", 4);
              expect(await queue.claim("foreign", { ownerId: "foreign-owner" })).not.toBeNull();
              await enqueue("other-lane", "lane", "other");
              await enqueue("retry-delayed", "lane", "lane");
              const retryClaim = expectDefined(await queue.claim("retry-delayed"), "retry claim");
              await queue.release(retryClaim, { lastError: "retry", releasedAt: currentNow });

              const readBacklog = expectDefined(
                lifecycles.get("self")?.readLaneBacklog,
                "backlog reader",
              );
              const pendingBefore = await queue.listPending();
              const claimsBefore = await queue.listClaims();
              expect((await readBacklog()).map((row) => row.id)).toEqual(expectedIds);
              const readDispatchingBacklog = expectDefined(
                lifecycles.get("dispatching")?.readLaneBacklog,
                "dispatching backlog reader",
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
            }
          },
          () => currentNow,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  drainIt(
    "preserves rejected stored lanes and attempts each snapshot candidate once",
    async ({ queue, enqueue, createDrain, dispatches }) => {
      await enqueue("active", "topic", "topic");
      const active = createDeferredCore();

      const drain = createDrain({
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: () => false,
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "active") {
            await active.promise;
          }
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active"]));
      await enqueue("candidate", "topic", "control");

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active", "candidate"]));
      await expect(queue.enqueue("candidate", { text: "topic" })).resolves.toMatchObject({
        kind: "completed",
      });

      active.resolve();
      await drain.waitForIdle();
    },
  );

  it("keeps a released lane head ahead of its tail when settlement crosses the drain snapshot", async () => {
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, dispatches }) => {
        await enqueue("head", "head", "same", 1);
        await enqueue("tail", "tail", "same", 2);
        const started = createDeferredCore();
        const failHead = createDeferredCore();

        const first = createDrain({
          dispatchClaimedEvent: async () => {
            started.resolve();
            await failHead.promise;
            return { kind: "failed-retryable", error: new Error("retry head") };
          },
        });
        const replacement = createDrain({ retryPolicy: { baseMs: 0, maxMs: 0 } });
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
          const listUnsettled = expectDefined(queue.listUnsettled, "unsettled reader").bind(queue);
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
      },
      () => 10_000,
    );
  });

  it.each([
    { delayed: "tail", settleHead: false, expected: ["head"] },
    { delayed: "head", settleHead: false, expected: [] },
    { delayed: "tail", settleHead: true, expected: [] },
  ])(
    "respects backoff for $delayed with settled head=$settleHead",
    async ({ delayed, settleHead, expected }) => {
      await withDrainFixture(async ({ queue, enqueue, createDrain, dispatches }) => {
        const currentNow = 10_000_000;
        await enqueue("head", "head", "user:U1", 1_000);
        await enqueue("tail", "tail", "user:U1", 2_000);
        const delayedClaim = await queue.claim(delayed);
        expect(delayedClaim).not.toBeNull();
        await queue.release(delayedClaim!, { lastError: "boom", releasedAt: currentNow });
        if (settleHead) {
          // The snapshot still contains a head that a sibling settles before selection.
          const snapshot = await queue.listUnsettled!({ orderBy: "received" });
          const headClaim = await queue.claim("head");
          expect(headClaim).not.toBeNull();
          await queue.complete(headClaim!);
          vi.spyOn(queue, "listUnsettled").mockResolvedValue(snapshot);
        }

        const drain = createDrain({
          now: () => currentNow,
          retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        });

        await expect(drain.drainOnce()).resolves.toEqual({ started: expected.length });
        if (expected.length) {
          await vi.waitFor(() => expect(dispatches).toEqual(expected));
        } else {
          expect(dispatches).toEqual(expected);
        }
        await drain.waitForIdle();
      });
    },
  );
});
