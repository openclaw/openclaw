import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withDrainFixture } from "./ingress-drain-suite.test-support.js";
import { isIngressAdoptionLostError } from "./ingress-drain.js";
import { seedPendingBacklog } from "./ingress-drain.test-helpers.js";

const drainIt = (name: string, run: Parameters<typeof withDrainFixture<void>>[0]) =>
  it(name, () => withDrainFixture(run));

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress drain", () => {
  it.each(["orphan", "dead-letter"] as const)(
    "dispatches recovered %s exactly once",
    async (kind) => {
      await withDrainFixture(
        async ({ queue, enqueue, createDrain, dispatches, events }) => {
          const id = kind === "orphan" ? "evt-1" : "evt-replay";
          const text = kind === "orphan" ? "hello" : "recover";
          await enqueue(id, text, "lane-a");
          const claim = expectDefined(
            await queue.claim(id, {
              ownerId: kind === "orphan" ? "999:1:dead-owner" : "worker",
            }),
            "original claim",
          );
          if (kind === "dead-letter") {
            await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
            const resubmit = expectDefined(queue.resubmit, "resubmit");
            await expect(resubmit.call(queue, id, { resubmittedAt: 30 })).resolves.toMatchObject({
              kind: "resubmitted",
              record: { attempts: 0, receivedAt: 30 },
            });
          }
          const drain = createDrain();
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
          expect(dispatches).toEqual([id]);
          if (kind === "orphan") {
            expect((await queue.enqueue(id, { text })).kind).toBe("completed");
          }
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          await drain.waitForIdle();
          expect(dispatches).toEqual([id]);
          if (kind === "dead-letter") {
            expect(events[0]).toMatchObject({ id, payload: { text }, attempts: 0 });
          }
        },
        kind === "orphan" ? () => 1_000 : undefined,
      );
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
          // Ownership must be registered before synchronous deferral releases it.
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(drain.activeLaneKeys()).toEqual(new Set());

      await enqueue("second", "second", "shared");
      expect(await drain.drainOnce()).toEqual({ started: 1 });
    },
  );

  it.each(["watchdog", "reclaimed", "storage-error"] as const)(
    "preserves claim ownership through %s",
    async (outcome) => {
      let clock = 1_000;
      await withDrainFixture(
        async ({ queue, enqueue, createDrain }) => {
          const watchdog = outcome === "watchdog";
          const id = watchdog
            ? "released-stall"
            : outcome === "reclaimed"
              ? "evt-refresh-false"
              : "evt-refresh-reject";
          await enqueue(id, "x", watchdog ? "shared" : "l1");
          const refreshClaim = vi
            .fn<NonNullable<typeof queue.refreshClaim>>()
            .mockResolvedValue(outcome !== "reclaimed");
          if (outcome === "storage-error") {
            refreshClaim.mockRejectedValueOnce(new Error("refresh storage failed"));
          }
          queue.refreshClaim = refreshClaim;
          const logs: string[] = [];
          let signal: AbortSignal | undefined;
          let adoptError: unknown;
          const hold = createDeferred();
          const drain = createDrain({
            claimLeaseMs: 3_000,
            ...(watchdog
              ? { adoptionStallTimeoutMs: 2_000, deferredLaneOccupancy: "release" }
              : {}),
            onLog: (message) => logs.push(message),
            dispatchClaimedEvent: async (_event, lifecycle) => {
              signal = lifecycle.abortSignal;
              if (watchdog) {
                return { kind: "deferred" };
              }
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
          if (watchdog) {
            await vi.waitFor(() => expect(drain.activeLaneKeys()).toEqual(new Set()));
          }
          clock += 1_000;
          await vi.advanceTimersByTimeAsync(1_000);
          if (outcome === "reclaimed") {
            expect(refreshClaim).toHaveBeenCalled();
            await vi.waitFor(() => expect(signal?.aborted).toBe(true));
          } else {
            expect(refreshClaim).toHaveBeenCalledTimes(1);
            clock += 1_000;
            await vi.advanceTimersByTimeAsync(1_000);
            if (watchdog) {
              await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
              expect(await queue.listFailed?.()).toEqual([]);
              expect(await queue.listPending({ limit: "all" })).toMatchObject([
                { id, attempts: 1, lastError: expect.stringContaining("handler-timeout") },
              ]);
            } else {
              expect(refreshClaim).toHaveBeenCalledTimes(2);
            }
          }
          hold.resolve();
          await drain.waitForIdle();
          if (outcome === "reclaimed") {
            expect(isIngressAdoptionLostError(adoptError)).toBe(true);
            expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("guillotined");
          } else if (!watchdog) {
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

  it.each(["retry", "terminal"] as const)("applies deferred %s failure policy", async (policy) => {
    let clock = 10_000;
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, byId, events }) => {
        const retry = policy === "retry";
        const ids = retry ? ["late-failure"] : ["non-retryable", "retry-limit"];
        for (const [index, id] of ids.entries()) {
          await enqueue(id, "x", retry ? "shared" : index ? "two" : "one", retry ? clock : 1);
        }
        const drain = createDrain({
          deferredLaneOccupancy: "release",
          retryPolicy: retry
            ? { baseMs: 1_000, maxMs: 1_000 }
            : { maxAttempts: 1, deadLetterMinAgeMs: 0 },
          ...(!retry
            ? {
                resolveNonRetryableFailure: (error: unknown) =>
                  error instanceof Error && error.message === "fatal input"
                    ? { reason: "invalid-input", message: error.message }
                    : null,
              }
            : {}),
          dispatchClaimedEvent: () => ({ kind: "deferred" }),
        });
        expect(await drain.drainOnce()).toEqual({ started: ids.length });
        await vi.waitFor(() => expect(events).toHaveLength(ids.length));
        expect(byId.size).toBe(ids.length);
        await expectDefined(
          byId.get(retry ? "late-failure" : "non-retryable")?.onFailed,
          "failure callback",
        )(new Error(retry ? "late provider failure" : "fatal input"));
        if (retry) {
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: "late-failure", attempts: 1, lastError: "late provider failure" },
          ]);
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          clock += 1_000;
          expect(await drain.drainOnce()).toEqual({ started: 1 });
        } else {
          await expectDefined(
            byId.get("retry-limit")?.onFailed,
            "failure callback",
          )(new Error("still broken"));
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "non-retryable", reason: "invalid-input", message: "fatal input" },
            { id: "retry-limit", reason: "retry-limit-exceeded", message: "still broken" },
          ]);
        }
      },
      () => clock,
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

      const abandoned = vi.fn();
      const abandonment = Promise.resolve(
        expectDefined(capturedLifecycles[0], "deferred lifecycle").onAbandoned(),
      ).then(abandoned);
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(abandoned).not.toHaveBeenCalled();
      expect(await queue.listClaims()).toHaveLength(1);

      finishRelease();
      await abandonment;
      expect(abandoned).toHaveBeenCalledOnce();
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
          lifecycle.onDeferred();
          await lifecycle.onAdopted();
          adoptCount += 1;
          await lifecycle.onAdopted();
          adoptCount += 1;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();
      expect(adoptCount).toBe(2);
      expect([await queue.listClaims(), await queue.listPending()]).toEqual([[], []]);
      expect((await queue.enqueue("evt-admit", { text: "x" })).kind).toBe("completed");
      expect(await drain.drainOnce()).toEqual({ started: 0 });
    },
  );

  it.each([false, true])("fences supersede when adoption wins=%s", async (adoptFirst) => {
    await withDrainFixture(async ({ queue, enqueue, createDrain }) => {
      await enqueue("old", "old", "shared");
      const hold = createDeferred();
      const predicate = createDeferred<boolean>();
      let predicateStarted = false;
      let adopted = false;
      const aborted = vi.fn();
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
            lifecycle.abortSignal.addEventListener("abort", aborted, { once: true });
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
        expect(aborted).not.toHaveBeenCalled();
        expect((await queue.enqueue("old", { text: "old" })).kind).toBe("completed");
      } else {
        expect(isIngressAdoptionLostError(adoptError)).toBe(true);
        expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("superseded");
      }
    });
  });

  drainIt(
    "does not steal live peer-drain claims; recovers after owner abort",
    async ({ enqueue, createDrain, dispatches }) => {
      await enqueue("evt-peer", "x", "l1");
      const { promise: firstHold, resolve: releaseFirst } = createDeferred();
      const firstAbort = new AbortController();
      const first = createDrain({
        abortSignal: firstAbort.signal,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await firstHold;
          await lifecycle.onAdopted();
        },
      });
      const second = createDrain();
      await first.drainOnce();
      expect(dispatches).toEqual(["evt-peer"]);
      expect(await second.recoverStaleClaims()).toBe(0);
      await second.drainOnce();
      expect(dispatches).toEqual(["evt-peer"]);
      firstAbort.abort();
      await expect(first.dispose({ waitForSettlements: true })).rejects.toThrow(
        "already-aborted retained owner",
      );
      // Recovery must precede the uncooperative handler's return.
      expect(await second.recoverStaleClaims()).toBeGreaterThanOrEqual(1);
      await second.drainOnce();
      await second.waitForIdle();
      expect(dispatches).toEqual(["evt-peer", "evt-peer"]);
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

      const drain = createDrain({ dispatchClaimedEvent: async () => ({ kind: "completed" }) });

      const idle = drain.waitForIdle();
      await drain.drainOnce();
      // 8 = module-private INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS (drain tombstone retry bound).
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(180_000);
      }
      await idle;

      expect(dispatches).toEqual(["evt-completed-tombstone-fail"]);
      expect((await queue.listClaims()).map((claim) => claim.id)).toContain(
        "evt-completed-tombstone-fail",
      );
      expect(drain.activeLaneKeys().has("l1")).toBe(true);

      await drain.drainOnce();
      await drain.waitForIdle();
      expect(dispatches).toEqual(["evt-completed-tombstone-fail"]);
    },
  );

  it("continues draining a backlog above SQLite's bind-variable ceiling", async () => {
    await withDrainFixture(
      async ({ createDrain, dispatches, stateDir }) => {
        seedPendingBacklog(stateDir, 33_000);

        const drain = createDrain();

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
      await withDrainFixture(async ({ queue, enqueue, createDrain, dispatches }) => {
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
        const drain = createDrain(
          {
            abortSignal: abort.signal,
            dispatchClaimedEvent: async (_event, lifecycle) => {
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
        const peer = createDrain();
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
          const disposalFinished = vi.fn();
          const disposal = drain.dispose({ waitForSettlements: true }).finally(disposalFinished);
          const rejection = expect(disposal).rejects.toBe(failure);
          finishWrite.resolve();
          await adoptionFailed.promise;
          if (timing === "during") {
            expect(disposalFinished).not.toHaveBeenCalled();
            finishSibling.resolve();
          }
          await rejection;
          expect(await peer.recoverStaleClaims()).toBe(0);
          expect(await peer.drainOnce()).toEqual({ started: 0 });
          expect(dispatches.toSorted()).toEqual(
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
        const original = expectDefined((await queue.listClaims())[0], "original claim");
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
      async ({ queue, enqueue, createDrain, byId, events }) => {
        await enqueue("evt-cancel", "x", "l1", 1);
        const failedClaim = expectDefined(
          await queue.claim("evt-cancel", { ownerId: "failed-owner" }),
          "failed claim",
        );
        await queue.release(failedClaim, { lastError: "previous failure", releasedAt: clock });
        const before = (await queue.listPending())[0];
        for (let cycle = 0; cycle < 3; cycle += 1) {
          clock += 1;
          const drain = createDrain({
            retryPolicy: { baseMs: 0, maxMs: 0 },
            dispatchClaimedEvent: () => ({ kind: "deferred" }),
          });
          await drain.drainOnce();
          await vi.waitFor(() => expect(events).toHaveLength(cycle + 1));
          await expectDefined(byId.get("evt-cancel")?.onCancelled, "onCancelled callback")();
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
        expect(await queue.listFailed?.()).toMatchObject([
          {
            id: "evt-cancel",
            attempts: 1,
            reason: "retry-limit-exceeded",
            message: "final genuine failure",
          },
        ]);
      },
      () => clock,
    );
  });
});
