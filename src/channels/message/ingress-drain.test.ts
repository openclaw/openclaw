import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { withDrainFixture } from "./ingress-drain-suite.test-support.js";
import { isIngressAdoptionLostError } from "./ingress-drain.js";
import { seedPendingBacklog } from "./ingress-drain.test-helpers.js";

const drainIt = (name: string, run: Parameters<typeof withDrainFixture<void>>[0]) =>
  it(name, () => withDrainFixture(run));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress drain", () => {
  it("crash-window: lost claim is recovered and dispatched exactly once", async () => {
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, dispatches }) => {
        await enqueue("evt-1", "hello", "lane-a");
        const orphanClaim = await queue.claim("evt-1", { ownerId: "999:1:dead-owner" });
        expect(orphanClaim).not.toBeNull();

        const drain = createDrain({});

        const { started } = await drain.drainOnce();
        await drain.waitForIdle();
        expect(started).toBe(1);
        expect(dispatches).toEqual(["evt-1"]);

        // Tombstone: re-enqueue hits completed, never redispatches.
        const again = await queue.enqueue("evt-1", { text: "hello" });
        expect(again.kind).toBe("completed");
        const second = await drain.drainOnce();
        await drain.waitForIdle();
        expect(second.started).toBe(0);
        expect(dispatches).toEqual(["evt-1"]);
      },
      () => 1_000,
    );
  });

  drainIt(
    "dispatches a resubmitted dead letter exactly once",
    async ({ queue, enqueue, createDrain }) => {
      await enqueue("evt-replay", "recover", "lane-a");
      const originalClaim = await queue.claim("evt-replay", { ownerId: "worker" });
      if (!originalClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(originalClaim, { reason: "handler-error", failedAt: 20 });
      if (!queue.resubmit) {
        throw new Error("Expected queue.resubmit");
      }
      await expect(queue.resubmit("evt-replay", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { attempts: 0, receivedAt: 30 },
      });

      const dispatch = vi.fn(
        async (_event: unknown, lifecycle: ChannelIngressDispatchLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const drain = createDrain({ dispatchClaimedEvent: dispatch });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        id: "evt-replay",
        payload: { text: "recover" },
        attempts: 0,
      });
    },
  );

  drainIt(
    "keeps the lane owned until a dead-letter write commits",
    async ({ queue, enqueue, createDrain, dispatches }) => {
      await enqueue("poison", "bad", "shared", 1);
      await enqueue("follower", "good", "shared", 2);
      const fail = queue.fail.bind(queue);
      let failAttempts = 0;
      queue.fail = async (...args) => {
        failAttempts += 1;
        if (failAttempts < 3) {
          throw new Error(`transient fail write ${failAttempts}`);
        }
        return await fail(...args);
      };

      const drain = createDrain({
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "poison") {
            throw new Error("poison delivery");
          }
          await lifecycle.onAdopted();
        },
      });

      await drain.drainOnce();
      const idle = drain.waitForIdle();
      await vi.advanceTimersByTimeAsync(0);
      expect(failAttempts).toBe(1);
      expect(drain.activeLaneKeys()).toEqual(new Set(["shared"]));
      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(dispatches).toEqual(["poison"]);

      await vi.advanceTimersByTimeAsync(5_000);
      await idle;
      expect(failAttempts).toBe(3);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(dispatches).toEqual(["poison", "follower"]);
    },
  );

  drainIt(
    "releases a deferred lane when the handler defers before its first await",
    async ({ enqueue, createDrain }) => {
      await enqueue("first", "first", "shared");
      const drain = createDrain({
        deferredLaneOccupancy: "release",
        dispatchClaimedEvent: async (_event, lifecycle) => {
          // Ownership must already be registered when a handler defers
          // synchronously, before its first await, or the release is undone by
          // the post-dispatch registration and the lane stays blocked.
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      // Settle the dispatch task, then read the lane state through its
      // completion signal instead of polling.
      await drain.waitForIdle();
      expect(drain.activeLaneKeys()).toEqual(new Set());

      await enqueue("second", "second", "shared");
      expect(await drain.drainOnce()).toEqual({ started: 1 });
    },
  );

  it("keeps heartbeat and watchdog ownership after releasing a deferred lane", async () => {
    let clock = 1_000;
    await withDrainFixture(
      async ({ queue, enqueue, createDrain }) => {
        await enqueue("released-stall", "x", "shared");
        const refreshClaim = vi.fn(async () => true);
        queue.refreshClaim = refreshClaim;
        const drain = createDrain({
          claimLeaseMs: 3_000,
          adoptionStallTimeoutMs: 2_000,
          deferredLaneOccupancy: "release",
          dispatchClaimedEvent: async () => ({ kind: "deferred" }),
        });

        await drain.drainOnce();
        await vi.waitFor(() => expect(drain.activeLaneKeys()).toEqual(new Set()));
        clock += 1_000;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(refreshClaim).toHaveBeenCalledTimes(1);

        clock += 1_000;
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
        expect(await queue.listFailed?.()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: "released-stall",
            attempts: 1,
            lastError: expect.stringContaining("handler-timeout"),
          },
        ]);
      },
      () => clock,
    );
  });

  it("applies retry, non-retryable, and retry-limit policy to deferred failures", async () => {
    let clock = 10_000;
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, lifecycles }) => {
        await enqueue("late-failure", "x", "shared", clock);

        const drain = createDrain({
          deferredLaneOccupancy: "release",
          retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
          dispatchClaimedEvent: async () => ({ kind: "deferred" }),
        });

        await drain.drainOnce();
        await vi.waitFor(() => expect(lifecycles).toHaveLength(1));
        const onFailed = expectDefined(lifecycles[0]?.onFailed, "onFailed callback");
        await onFailed(new Error("late provider failure"));

        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: "late-failure", attempts: 1, lastError: "late provider failure" },
        ]);
        expect(await drain.drainOnce()).toEqual({ started: 0 });
        clock += 1_000;
        expect(await drain.drainOnce()).toEqual({ started: 1 });
      },
      () => clock,
    );
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, byId: lifecycles }) => {
        await enqueue("non-retryable", "x", "one", 1);
        await enqueue("retry-limit", "x", "two", 1);

        const drain = createDrain({
          deferredLaneOccupancy: "release",
          retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
          resolveNonRetryableFailure: (error) =>
            error instanceof Error && error.message === "fatal input"
              ? { reason: "invalid-input", message: error.message }
              : null,
          dispatchClaimedEvent: async () => ({ kind: "deferred" }),
        });

        expect(await drain.drainOnce()).toEqual({ started: 2 });
        await vi.waitFor(() => expect(lifecycles.size).toBe(2));
        await expectDefined(
          lifecycles.get("non-retryable")?.onFailed,
          "onFailed callback",
        )(new Error("fatal input"));
        await expectDefined(
          lifecycles.get("retry-limit")?.onFailed,
          "onFailed callback",
        )(new Error("still broken"));

        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: "non-retryable", reason: "invalid-input", message: "fatal input" },
          { id: "retry-limit", reason: "retry-limit-exceeded", message: "still broken" },
        ]);
      },
      () => 10_000,
    );
  });

  drainIt(
    "lets callers await an abandoned claim release",
    async ({ queue, enqueue, createDrain, lifecycles: capturedLifecycles }) => {
      await enqueue("evt-await-abandon", "x", "l1");

      const { promise: releaseGate, resolve: finishRelease } = createDeferred();
      const release = vi.fn(async (...args: Parameters<typeof queue.release>) => {
        await releaseGate;
        return await queue.release(...args);
      });

      const drain = createDrain({
        queue: { ...queue, release },
        dispatchClaimedEvent: async () => ({ kind: "deferred" }),
      });

      await drain.drainOnce();
      await vi.waitFor(() => expect(capturedLifecycles).toHaveLength(1));

      let abandoned = false;
      const abandonment = Promise.resolve(
        expectDefined(capturedLifecycles[0], "deferred lifecycle").onAbandoned(),
      ).then(() => {
        abandoned = true;
      });
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(abandoned).toBe(false);
      expect(await queue.listClaims()).toHaveLength(1);

      finishRelease();
      await abandonment;
      expect(abandoned).toBe(true);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toHaveLength(1);
    },
  );

  drainIt(
    "queued deferral -> admission completes the claim exactly once",
    async ({ queue, enqueue, createDrain }) => {
      await enqueue("evt-admit", "x", "l1");

      let adoptCount = 0;
      const drain = createDrain({
        dispatchClaimedEvent: async (_event, lifecycle) => {
          // Simulate queue enqueue (defer) then reply-lane admission (adopt).
          lifecycle.onDeferred();
          await lifecycle.onAdopted();
          adoptCount += 1;
          // Second adopt from lifecycle must be a no-op for the claim.
          await lifecycle.onAdopted();
          adoptCount += 1;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();
      expect(adoptCount).toBe(2);
      expect([await queue.listClaims(), await queue.listPending()]).toEqual([[], []]);
      const status = await queue.enqueue("evt-admit", { text: "x" });
      expect(status.kind).toBe("completed");
      // No re-dispatch on later drain.
      const second = await drain.drainOnce();
      expect(second.started).toBe(0);
    },
  );

  it.each([false, true])("fences supersede when adoption wins=%s", async (adoptFirst) => {
    await withDrainFixture(async ({ queue, enqueue, createDrain }) => {
      await enqueue("old", "old", "shared");
      const hold = createDeferred();
      const predicate = createDeferred<boolean>();
      let predicateStarted = false;
      let adopted = false;
      let aborted = false;
      let adoptError: unknown;
      const drain = createDrain({
        shouldSupersedePending: adoptFirst
          ? async () => {
              predicateStarted = true;
              return predicate.promise;
            }
          : () => true,
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "old") {
            lifecycle.abortSignal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
            await hold.promise;
            try {
              await lifecycle.onAdopted();
              adopted = true;
            } catch (error) {
              adoptError = error;
              throw error;
            }
            return;
          }
          await lifecycle.onAdopted();
        },
      });
      await drain.drainOnce();
      await enqueue("new", "new", "shared");
      const next = drain.drainOnce();
      if (adoptFirst) {
        await vi.waitFor(() => expect(predicateStarted).toBe(true));
        hold.resolve();
        await vi.waitFor(() => expect(adopted).toBe(true));
        predicate.resolve(true);
        await next;
      } else {
        await next;
        hold.resolve();
      }
      await drain.waitForIdle();
      if (adoptFirst) {
        expect(aborted).toBe(false);
        expect((await queue.enqueue("old", { text: "old" })).kind).toBe("completed");
      } else {
        expect(isIngressAdoptionLostError(adoptError)).toBe(true);
        expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("superseded");
      }
    });
  });

  drainIt(
    "does not steal live peer-drain claims; recovers after owner abort",
    async ({ enqueue, createDrain }) => {
      await enqueue("evt-peer", "x", "l1");

      const { promise: firstHold, resolve: releaseFirst } = createDeferred();
      const firstDispatches: string[] = [];
      const secondDispatches: string[] = [];
      const firstAbort = new AbortController();

      const first = createDrain({
        abortSignal: firstAbort.signal,
        dispatchClaimedEvent: async (event, lifecycle) => {
          firstDispatches.push(event.id);
          await firstHold;
          await lifecycle.onAdopted();
        },
      });
      const second = createDrain({
        dispatchClaimedEvent: async (event, lifecycle) => {
          secondDispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await first.drainOnce();
      expect(firstDispatches).toEqual(["evt-peer"]);

      // Live peer must not steal the in-flight claim.
      const stealAttempt = await second.recoverStaleClaims();
      expect(stealAttempt).toBe(0);
      await second.drainOnce();
      expect(secondDispatches).toEqual([]);

      firstAbort.abort();
      await expect(first.dispose({ waitForSettlements: true })).rejects.toThrow(
        "already-aborted retained owner",
      );
      // Aborted owners retire before an uncooperative handler returns, allowing
      // the replacement drain to recover under the claim-token fence.
      const recovered = await second.recoverStaleClaims();
      expect(recovered).toBeGreaterThanOrEqual(1);
      await second.drainOnce();
      await second.waitForIdle();
      expect(secondDispatches).toEqual(["evt-peer"]);
      releaseFirst();
      await first.waitForIdle();
    },
  );

  drainIt(
    "tombstone-fail after handler completed keeps ownership and never re-dispatches",
    async ({ queue, enqueue, createDrain, dispatches }) => {
      await enqueue("evt-completed-tombstone-fail", "ran", "l1");

      queue.complete = async () => {
        throw new Error("tombstone write failed after dispatch completed");
      };

      const drain = createDrain({
        dispatchClaimedEvent: async () => {
          // Implicit complete path: return completed without calling onAdopted.
          return { kind: "completed" };
        },
      });

      const idle = drain.waitForIdle();
      await drain.drainOnce();
      // 8 = module-private INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS (drain tombstone retry bound).
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(180_000);
      }
      await idle;

      expect(dispatches).toEqual(["evt-completed-tombstone-fail"]);
      // Claim still held — not released for replay of already-executed work.
      const claims = await queue.listClaims();
      expect(claims.map((claim) => claim.id)).toContain("evt-completed-tombstone-fail");
      expect(drain.activeLaneKeys().has("l1")).toBe(true);

      // Later drain must not re-dispatch the same event.
      await drain.drainOnce();
      await drain.waitForIdle();
      expect(dispatches).toEqual(["evt-completed-tombstone-fail"]);
    },
  );

  it.each(["reclaimed", "storage-error"] as const)(
    "handles claim refresh %s without losing adoption fencing",
    async (outcome) => {
      let clock = 1_000;
      await withDrainFixture(
        async ({ queue, enqueue, createDrain }) => {
          const id = outcome === "reclaimed" ? "evt-refresh-false" : "evt-refresh-reject";
          await enqueue(id, "x", "l1");
          const refreshClaim = vi.fn<NonNullable<typeof queue.refreshClaim>>();
          if (outcome === "reclaimed") {
            refreshClaim.mockResolvedValue(false);
          } else {
            refreshClaim
              .mockRejectedValueOnce(new Error("refresh storage failed"))
              .mockResolvedValue(true);
          }
          queue.refreshClaim = refreshClaim;
          const logs: string[] = [];
          let signal: AbortSignal | undefined;
          let adoptError: unknown;
          const hold = createDeferred();
          const drain = createDrain({
            claimLeaseMs: 3_000,
            onLog: (message) => logs.push(message),
            dispatchClaimedEvent: async (_event, lifecycle) => {
              signal = lifecycle.abortSignal;
              await hold.promise;
              try {
                await lifecycle.onAdopted();
              } catch (error) {
                adoptError = error;
                if (outcome === "reclaimed") {
                  throw error;
                }
              }
            },
          });
          await drain.drainOnce();
          clock += 1_000;
          await vi.advanceTimersByTimeAsync(1_000);
          if (outcome === "reclaimed") {
            expect(refreshClaim).toHaveBeenCalled();
            await vi.waitFor(() => expect(signal?.aborted).toBe(true));
          } else {
            expect(refreshClaim).toHaveBeenCalledTimes(1);
            clock += 1_000;
            await vi.advanceTimersByTimeAsync(1_000);
            expect(refreshClaim).toHaveBeenCalledTimes(2);
          }
          hold.resolve();
          await drain.waitForIdle();
          if (outcome === "reclaimed") {
            expect(isIngressAdoptionLostError(adoptError)).toBe(true);
            expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("guillotined");
          } else {
            expect(signal?.aborted).toBe(false);
            expect(adoptError).toBeUndefined();
            expect(await queue.listClaims()).toEqual([]);
            expect(logs).toEqual([
              "ingress drain: claim refresh failed for event evt-refresh-reject; holding claim: refresh storage failed",
            ]);
          }
        },
        () => clock,
      );
    },
  );

  it("continues draining a backlog above SQLite's bind-variable ceiling", async () => {
    await withDrainFixture(
      async ({ createDrain, dispatches, stateDir }) => {
        seedPendingBacklog(stateDir, 33_000);

        const drain = createDrain({});

        await expect(drain.drainOnce()).resolves.toEqual({ started: 32 });
        await drain.waitForIdle();
        await expect(drain.drainOnce()).resolves.toEqual({ started: 32 });
        await drain.waitForIdle();
        expect(dispatches).toEqual(Array.from({ length: 64 }, (_, index) => `evt-${index}`));
      },
      () => 1_000,
    );
  });
});

describe("channel ingress drain ownership", () => {
  it.each([
    { method: "complete", envelope: "aggregate" },
    { method: "release", envelope: "cause" },
  ] as const)(
    "holds custody without replaying $method after a $envelope unknown outcome",
    async ({ method, envelope }) => {
      await withDrainFixture(async ({ queue, enqueue, createDrain }) => {
        await enqueue("unknown-settlement", "delivered", "lane");
        const unknown = new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown");
        const failure = new Error("Synthetic cleanup failure", {
          cause: envelope === "aggregate" ? new AggregateError([unknown]) : unknown,
        });
        const write = vi.spyOn(queue, method).mockRejectedValue(failure);
        const shutdown = new AbortController();
        const drain = createDrain(
          {
            abortSignal: shutdown.signal,
            dispatchClaimedEvent: async (_event, lifecycle) => {
              if (method === "complete") {
                return await lifecycle.onAdopted();
              }
              return { kind: "failed-retryable", error: new Error("Synthetic delivery failure") };
            },
          },
          method !== "complete",
        );
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          if (method === "complete") {
            await vi.advanceTimersByTimeAsync(1_000);
          }
          expect(write).toHaveBeenCalledOnce();
          expect((await queue.listClaims()).map((row) => row.id)).toEqual(["unknown-settlement"]);
          expect(drain.activeLaneKeys().has("lane")).toBe(true);
          if (method !== "complete") {
            shutdown.abort();
            await expect(drain.dispose({ waitForSettlements: true })).rejects.toBe(failure);
          }
        } finally {
          shutdown.abort();
          await drain.waitForIdle();
          drain.dispose();
          write.mockRestore();
        }
      });
    },
  );

  drainIt(
    "requires owner cancellation before finalizing retained claim custody",
    async ({ queue, enqueue, createDrain }) => {
      await enqueue("retained", "pending", "lane");
      const abort = new AbortController();
      let cancellation: Promise<void> | undefined;
      const drain = createDrain(
        {
          abortSignal: abort.signal,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycle.abortSignal.addEventListener(
              "abort",
              () => {
                cancellation = Promise.resolve(lifecycle.onCancelled?.());
              },
              { once: true },
            );
            return { kind: "deferred" };
          },
        },
        true,
      );
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        const claim = await queue.listClaims();
        expect(claim).toHaveLength(1);
        await expect(drain.dispose({ waitForSettlements: true })).rejects.toThrow(
          "already-aborted retained owner",
        );
        expect(cancellation).toBeUndefined();
        expect(await queue.listClaims()).toEqual(claim);

        abort.abort();
        await drain.dispose({ waitForSettlements: true });
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([{ id: "retained", attempts: 0 }]);
      } finally {
        abort.abort();
        await cancellation;
      }
    },
  );

  it.each(["before", "during"] as const)(
    "keeps failed completion custody when the write rejects %s joined disposal",
    async (timing) => {
      await withDrainFixture(async ({ queue, enqueue, createDrain }) => {
        await enqueue("completion-failure", "delivered", "lane");
        if (timing === "during") {
          await enqueue("sibling", "delivered", "other");
        }
        const writeStarted = createDeferredCore();
        const finishWrite = createDeferredCore();
        const siblingStarted = createDeferredCore();
        const finishSibling = createDeferredCore();
        const adoptionFailed = createDeferredCore();
        const failure = new Error("completion write failed");
        const complete = queue.complete.bind(queue);
        queue.complete = async (value, options) => {
          if (typeof value !== "string" && value.id === "sibling") {
            siblingStarted.resolve();
            await finishSibling.promise;
            return complete(value, options);
          }
          writeStarted.resolve();
          await finishWrite.promise;
          throw failure;
        };
        const abort = new AbortController();
        const delivered = vi.fn<(id: string) => void>();
        const drain = createDrain(
          {
            abortSignal: abort.signal,
            dispatchClaimedEvent: async (event, lifecycle) => {
              delivered(event.id);
              try {
                await lifecycle.onAdopted();
              } catch (error) {
                adoptionFailed.resolve();
                throw error;
              }
            },
          },
          true,
        );
        const peer = createDrain({ dispatchClaimedEvent: (event) => delivered(event.id) });
        try {
          await drain.drainOnce();
          await writeStarted.promise;
          if (timing === "during") {
            await siblingStarted.promise;
          }
          abort.abort();
          if (timing === "before") {
            finishWrite.resolve();
            await drain.waitForIdle();
          }
          let disposalFinished = false;
          const disposal = drain.dispose({ waitForSettlements: true }).finally(() => {
            disposalFinished = true;
          });
          const rejection = expect(disposal).rejects.toBe(failure);
          finishWrite.resolve();
          await adoptionFailed.promise;
          if (timing === "during") {
            expect(disposalFinished).toBe(false);
            finishSibling.resolve();
          }
          await rejection;
          expect(await peer.recoverStaleClaims()).toBe(0);
          expect(await peer.drainOnce()).toEqual({ started: 0 });
          expect(delivered.mock.calls.map(([id]) => id).toSorted()).toEqual(
            timing === "during" ? ["completion-failure", "sibling"] : ["completion-failure"],
          );
          expect(await queue.listClaims()).toMatchObject([{ id: "completion-failure" }]);
        } finally {
          abort.abort();
          finishWrite.resolve();
          finishSibling.resolve();
          await drain.waitForIdle();
        }
      });
    },
  );

  drainIt(
    "rejects adoption after reclaim without blocking disposal or disturbing the successor",
    async ({ queue, enqueue, createDrain }) => {
      await enqueue("evt-reclaim", "x", "l1");

      const adopt = createDeferredCore();
      const abort = new AbortController();
      let adoptError: unknown;
      const drain = createDrain(
        {
          abortSignal: abort.signal,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await adopt.promise;
            try {
              await lifecycle.onAdopted();
            } catch (err) {
              adoptError = err;
              throw err;
            }
          },
        },
        true,
      );
      try {
        await drain.drainOnce();
        const [original] = await queue.listClaims();
        if (!original) {
          throw new Error("Expected the original ingress claim");
        }
        expect(await queue.release(original)).toBe(true);
        const successor = await queue.claim("evt-reclaim", { ownerId: "replacement" });
        expect(successor).not.toBeNull();
        adopt.resolve();
        await drain.waitForIdle();
        expect(isIngressAdoptionLostError(adoptError)).toBe(true);
        expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("reclaimed");
        expect(drain.activeLaneKeys().has("l1")).toBe(true);

        abort.abort();
        await drain.dispose({ waitForSettlements: true });
        expect(await queue.listClaims()).toEqual([successor]);
      } finally {
        adopt.resolve();
        abort.abort();
        await drain.waitForIdle();
      }
    },
  );
});

describe("channel ingress drain cancellation", () => {
  it("cancels unadopted work without changing its retry facts", async () => {
    let clock = 100;
    await withDrainFixture(
      async ({ queue, enqueue, createDrain }) => {
        await enqueue("evt-cancel", "x", "l1", 1);
        const failedClaim = await queue.claim("evt-cancel", { ownerId: "failed-owner" });
        expect(failedClaim).not.toBeNull();
        if (!failedClaim) {
          return;
        }
        await queue.release(failedClaim, { lastError: "previous failure", releasedAt: clock });
        const before = (await queue.listPending())[0];
        for (let cycle = 0; cycle < 3; cycle += 1) {
          const lifecycles: ChannelIngressDispatchLifecycle[] = [];
          clock += 1;
          const drain = createDrain({
            retryPolicy: { baseMs: 0, maxMs: 0 },
            dispatchClaimedEvent: async (_event, lifecycle) => {
              lifecycles.push(lifecycle);
              return { kind: "deferred" };
            },
          });

          await drain.drainOnce();
          await vi.waitFor(() => expect(lifecycles).toHaveLength(1));
          await expectDefined(lifecycles[0]?.onCancelled, "onCancelled callback")();
          expect(await queue.listPending()).toMatchObject([
            {
              id: "evt-cancel",
              attempts: before?.attempts,
              lastAttemptAt: before?.lastAttemptAt,
              lastError: before?.lastError,
            },
          ]);
          expect(await queue.listClaims()).toEqual([]);
          drain.dispose();
        }

        const terminal = createDrain({
          retryPolicy: { maxAttempts: 2, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async () => {
            throw new Error("final genuine failure");
          },
        });
        await terminal.drainOnce();
        await terminal.waitForIdle();
        expect(await queue.listFailed?.()).toEqual([
          expect.objectContaining({
            id: "evt-cancel",
            attempts: 1,
            reason: "retry-limit-exceeded",
            message: "final genuine failure",
          }),
        ]);
      },
      () => clock,
    );
  });
});
