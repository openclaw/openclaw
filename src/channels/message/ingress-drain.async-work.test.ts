import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { runDetachedWebhookWork } from "../../plugin-sdk/webhook-request-guards.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";

describe("channel ingress drain async work ownership", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("tracks a monitor delivery after its webhook pump closes and a queued followup after delivery settles", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const turnGate = createDeferredCore();
      const followupGate = createDeferredCore();
      const followupFinished = createDeferredCore();
      const pumpSignals: AbortSignal[] = [];
      const events: string[] = [];
      const followupKey = `ingress-async-work:${stateDir}`;
      const monitor = createChannelIngressMonitor<Payload, Payload, Payload>({
        queue,
        inspect: (raw) => ({ eventId: raw.text, laneKey: "lane-a" }),
        payload: {
          version: 1,
          serialize: (raw) => raw,
          deserialize: (raw) => raw,
          encode: ({ body }) => body,
          decode: (body) => ({ version: 1, body }),
          createClaimError: (kind) => new Error(kind),
        },
        pollIntervalMs: 60_000,
        retention: "standard",
        runPumpTask: (work) =>
          runDetachedWebhookWork(async () => {
            const signal = getAsyncWorkSignal();
            expect(signal).toBeDefined();
            if (signal) {
              pumpSignals.push(signal);
            }
            await work();
          }),
        deliver: async (_raw, lifecycle) => {
          await turnGate.promise;
          await trackAsyncWork(() => events.push("turn"));
          enqueueFollowupRun(followupKey, createQueueTestRun({ prompt: "followup" }), {
            mode: "followup",
            debounceMs: 0,
          });
          scheduleFollowupDrain(followupKey, async () => {
            try {
              await followupGate.promise;
              await trackAsyncWork(() => events.push("followup"));
            } finally {
              followupFinished.resolve();
            }
          });
          await lifecycle.onAdopted();
        },
      });

      try {
        await monitor.admit({ text: "evt-scope" });
        monitor.start();
        await monitor.waitForPumpIdle();
        await vi.waitFor(() => expect(pumpSignals[0]?.aborted).toBe(true));
        expect(events).toEqual([]);

        turnGate.resolve();
        await monitor.waitForIdle();
        expect(events).toEqual(["turn"]);
        await expect(queue.listPending()).resolves.toEqual([]);
        await expect(queue.listClaims()).resolves.toEqual([]);

        followupGate.resolve();
        await followupFinished.promise;
        expect(events).toEqual(["turn", "followup"]);
      } finally {
        turnGate.resolve();
        followupGate.resolve();
        await monitor.stop();
        clearSessionQueues([followupKey]);
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
    });
  });
});
