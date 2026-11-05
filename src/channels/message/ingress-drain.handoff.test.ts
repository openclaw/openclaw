import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

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
});
