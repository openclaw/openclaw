// Pre-adoption stall watchdog contract tests: cancellation, ownership fencing,
// retry preservation, and dead-letter escalation.
//
// Split out of ingress-drain.test.ts (which is at its max-lines budget) to match
// the ingress-drain-stall-watchdog.ts source extraction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, DEFAULT_INGRESS_ADOPTION_STALL_MS } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain: pre-adoption stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("requeues a pre-adoption stall for retry once the aborted dispatch exits", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall-requeue", { text: "user message" }, { laneKey: "l1" });

      let dispatches = 0;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        stallQuiesceMs: 1_000,
        // No retryPolicy override: defaults must preserve the inbound message.
        dispatchClaimedEvent: async (_event, lifecycle) => {
          dispatches += 1;
          // Cooperative dispatch: observes the abort and exits.
          await new Promise<void>((resolve) => {
            if (lifecycle.abortSignal.aborted) {
              resolve();
              return;
            }
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      // Let the cancellation fence observe the exited dispatch.
      await vi.advanceTimersByTimeAsync(1_000);
      await drain.waitForIdle();

      // The stalled event must NOT be dead-lettered: it was never handled, so
      // destroying it silently loses a user message.
      const failed = await queue.listFailed?.();
      expect(failed ?? []).toHaveLength(0);
      expect(dispatches).toBe(1);

      // It is still queued (pending retry), so the payload survives.
      const reenqueue = await queue.enqueue("evt-stall-requeue", { text: "user message" });
      expect(reenqueue.kind).not.toBe("failed");
      drain.dispose();
    });
  });

  it("holds ownership when an aborted pre-adoption dispatch has not exited", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall-fence", { text: "user message" }, { laneKey: "l1" });

      let dispatches = 0;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        stallQuiesceMs: 1_000,
        dispatchClaimedEvent: async () => {
          dispatches += 1;
          // Abort-ignoring: still running after cancellation.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Fence expired without the dispatch exiting: ownership is retained rather
      // than released into a concurrent re-dispatch. Wedged beats duplicated.
      expect(await queue.listClaims()).toHaveLength(1);
      const failed = await queue.listFailed?.();
      expect(failed ?? []).toHaveLength(0);

      // A second pump must not re-dispatch the still-running event.
      await drain.drainOnce();
      expect(dispatches).toBe(1);
      drain.dispose();
    });
  });

  it("watchdog only guillotines pre-adoption stalls with handler-timeout", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: async () => {
          // Never adopt, never return — stall until watchdog.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      // Failed tombstone, not pending retry.
      const reenqueue = await queue.enqueue("evt-stall", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("watchdog guillotines deferred phase (timer not cleared by deferral)", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          // Stay deferred without adoption — watchdog must still fire.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      const reenqueue = await queue.enqueue("evt-def-stall", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("watchdog does not kill healthy long turns after adoption", async () => {
    await withTempState(async (stateDir) => {
      let clock = 20_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-long", { text: "x" }, { laneKey: "l1" });

      let settleResolve!: () => void;
      const settleGate = new Promise<void>((resolve) => {
        settleResolve = resolve;
      });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
          await settleGate;
        },
      });

      await drain.drainOnce();
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toEqual([]);
      });
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      // Still only completed — not failed by watchdog.
      const status = await queue.enqueue("evt-long", { text: "x" });
      expect(status.kind).toBe("completed");
      settleResolve();
      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("exports default adoption stall matching Telegram product default", () => {
    expect(DEFAULT_INGRESS_ADOPTION_STALL_MS).toBe(5 * 60 * 1000);
  });
});
