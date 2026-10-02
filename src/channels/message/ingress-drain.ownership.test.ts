import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, isIngressAdoptionLostError } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["direct", "wrapped"] as const)(
    "holds the claim without replaying a complete with a %s unknown native outcome",
    async (envelope) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("unknown-complete", { text: "delivered" }, { laneKey: "lane" });
        const unknown = new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown");
        const failure =
          envelope === "direct"
            ? unknown
            : new Error("Synthetic cleanup failure", { cause: new AggregateError([unknown]) });
        const entered = createDeferredCore();
        let attempts = 0;
        queue.complete = async () => {
          attempts++;
          entered.resolve();
          throw failure;
        };
        const shutdown = new AbortController();
        const drain = createChannelIngressDrain<Payload>({
          queue,
          abortSignal: shutdown.signal,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await lifecycle.onAdopted();
          },
        });
        try {
          await drain.drainOnce();
          await entered.promise;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(attempts).toBe(1);
          expect((await queue.listClaims()).map((row) => row.id)).toEqual(["unknown-complete"]);
          expect(drain.activeLaneKeys().has("lane")).toBe(true);
        } finally {
          shutdown.abort();
          await drain.waitForIdle();
          drain.dispose();
        }
      });
    },
  );

  it.each(["release", "fail"] as const)(
    "does not reenter a %s settlement whose native outcome is unknown",
    async (method) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("unknown-settlement", { text: "delivered" }, { laneKey: "lane" });
        const failure = new Error("Synthetic cleanup failure", {
          cause: new SqliteWorkerError("Synthetic lost native outcome", "outcome-unknown"),
        });
        const write = vi.spyOn(queue, method).mockRejectedValue(failure);
        const shutdown = new AbortController();
        const drain = createChannelIngressDrain<Payload>(
          {
            queue,
            abortSignal: shutdown.signal,
            ...(method === "fail"
              ? {
                  resolveNonRetryableFailure: () => ({
                    reason: "invalid-event",
                    message: "invalid",
                  }),
                }
              : {}),
            dispatchClaimedEvent: async () => ({
              kind: "failed-retryable",
              error: new Error("Synthetic delivery failure"),
            }),
          },
          true,
        );
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(write).toHaveBeenCalledOnce();
          expect((await queue.listClaims()).map((row) => row.id)).toEqual(["unknown-settlement"]);
          expect(drain.activeLaneKeys().has("lane")).toBe(true);
          shutdown.abort();
          await expect(drain.dispose({ waitForSettlements: true })).rejects.toBe(failure);
        } finally {
          shutdown.abort();
          await drain.waitForIdle();
          drain.dispose();
          write.mockRestore();
        }
      });
    },
  );

  it("requires owner cancellation before finalizing retained claim custody", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("retained", { text: "pending" }, { laneKey: "lane" });
      const abort = new AbortController();
      let cancellation: Promise<void> | undefined;
      const drain = createChannelIngressDrain<Payload>(
        {
          queue,
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
        drain.dispose();
      }
    });
  });

  it.each(["before", "during"] as const)(
    "keeps failed completion custody when the write rejects %s joined disposal",
    async (timing) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("completion-failure", { text: "delivered" }, { laneKey: "lane" });
        if (timing === "during") {
          await queue.enqueue("sibling", { text: "delivered" }, { laneKey: "other" });
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
        const drain = createChannelIngressDrain(
          {
            queue,
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
        const peer = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: (event) => delivered(event.id),
        });
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
          drain.dispose();
          peer.dispose();
        }
      });
    },
  );

  it("rejects adoption after reclaim without blocking disposal or disturbing the successor", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-reclaim", { text: "x" }, { laneKey: "l1" });

      const adopt = createDeferredCore();
      const abort = new AbortController();
      let adoptError: unknown;
      const drain = createChannelIngressDrain<Payload>(
        {
          queue,
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
        drain.dispose();
      }
    });
  });
});
