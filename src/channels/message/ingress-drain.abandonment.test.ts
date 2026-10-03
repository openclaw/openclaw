import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain abandonment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("charges one attempt per abandonment, dead-letters at the threshold, and frees the lane", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const maxAttempts = 3;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("abandoned", { text: "x" }, { laneKey: "l", receivedAt: 1 });
      await queue.enqueue("next", { text: "y" }, { laneKey: "l", receivedAt: 2 });
      const fail = vi.spyOn(queue, "fail");
      const dispatched: string[] = [];
      const pendingPerPass: Array<Array<{ id: string; attempts: number }>> = [];

      // One pass per attempt, then one more so the lane can move on.
      for (let pass = 0; pass <= maxAttempts; pass += 1) {
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: { maxAttempts, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async (event, lifecycle) => {
            dispatched.push(event.id);
            if (event.id !== "abandoned") {
              return { kind: "completed" };
            }
            // A doubled callback still settles once per claim.
            await Promise.all([lifecycle.onAbandoned(), lifecycle.onAbandoned()]);
            return { kind: "deferred" };
          },
        });
        await drain.drainOnce();
        await drain.waitForIdle();
        drain.dispose();
        pendingPerPass.push(
          (await queue.listPending()).map((row) => ({ id: row.id, attempts: row.attempts })),
        );
      }

      expect(pendingPerPass).toEqual([
        [
          { id: "abandoned", attempts: 1 },
          { id: "next", attempts: 0 },
        ],
        [
          { id: "abandoned", attempts: 2 },
          { id: "next", attempts: 0 },
        ],
        // The threshold abandonment dead-letters; the lane is no longer blocked.
        [{ id: "next", attempts: 0 }],
        [],
      ]);
      // Lane order held while the head row burned its budget, then "next" ran.
      expect(dispatched).toEqual(["abandoned", "abandoned", "abandoned", "next"]);
      expect(fail).toHaveBeenCalledOnce();
      expect(await queue.listFailed?.()).toEqual([
        expect.objectContaining({
          id: "abandoned",
          attempts: maxAttempts - 1,
          reason: "retry-limit-exceeded",
          message: "turn-abandoned",
          payload: { text: "x" },
        }),
      ]);
    });
  });

  it("keeps a young over-limit abandonment pending until deadLetterMinAgeMs", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("young", { text: "x" }, { laneKey: "l", receivedAt: 1_000 });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 60_000, baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await lifecycle.onAbandoned();
            return { kind: "deferred" };
          },
        });
        await drain.drainOnce();
        await drain.waitForIdle();
        drain.dispose();
      }

      // Over the attempt ceiling but under the age floor: still retryable.
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "young", attempts: 2, lastError: "turn-abandoned" }),
      ]);
      expect(await queue.listFailed?.()).toEqual([]);
    });
  });
});
