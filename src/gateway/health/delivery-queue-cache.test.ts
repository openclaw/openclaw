import { afterEach, describe, expect, it, vi } from "vitest";
import * as ingressHealth from "../../channels/message/ingress-queue-health.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import * as deliveryQueue from "../../infra/delivery-queue-sqlite.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";

describe("delivery queue health write receipts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses unchanged dead letters and refreshes both queues after committed writes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-health-dead-letters-" },
      async ({ stateDir }) => {
        openOpenClawStateDatabase();
        const outboundReads = vi.spyOn(deliveryQueue, "countFailedDeliveryQueueEntries");
        const ingressReads = vi.spyOn(ingressHealth, "countFailedChannelIngressQueueEntries");
        const pressureReads = vi.spyOn(ingressHealth, "countChannelIngressQueuePressure");
        expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
        expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
        expect(outboundReads).toHaveBeenCalledTimes(1);
        expect(ingressReads).toHaveBeenCalledTimes(1);
        expect(pressureReads).toHaveBeenCalledTimes(2);

        seedDeliveryQueueEntry({
          queueName: "outbound",
          entry: { id: "failed-outbound", enqueuedAt: 1_000, retryCount: 1 },
          status: "failed",
          stateDir,
        });
        expect(await buildDeliveryQueueHealthSummary()).toEqual({
          failed: [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }],
        });
        expect(outboundReads).toHaveBeenCalledTimes(2);
        expect(ingressReads).toHaveBeenCalledTimes(2);

        const ingress = createChannelIngressQueue<{ text: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
        });
        await ingress.enqueue("failed-inbound", { text: "synthetic failure" });
        await ingress.fail("failed-inbound", { reason: "rejected", failedAt: 2_000 });
        const updated = await buildDeliveryQueueHealthSummary();
        expect(updated).toEqual({
          failed: [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }],
          ingressFailed: [
            { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
          ],
        });
        expect(await buildDeliveryQueueHealthSummary()).toEqual(updated);
        expect(outboundReads).toHaveBeenCalledTimes(3);
        expect(ingressReads).toHaveBeenCalledTimes(3);
        expect(pressureReads).toHaveBeenCalledTimes(5);
      },
    );
  });
});
