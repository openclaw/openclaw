import { afterEach, describe, expect, it, vi } from "vitest";
import { INGRESS_CLAIM_LEASE_MS } from "../../channels/message/ingress-claim-owner.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import * as deliveryQueueWorker from "../../infra/delivery-queue-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";

describe("delivery queue health write receipts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses ingress health across unrelated writes and refreshes after queue writes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-health-dead-letters-" },
      async ({ stateDir }) => {
        openOpenClawStateDatabase();
        const outboundReads = vi.spyOn(deliveryQueueWorker, "executeDeliveryQueueOperation");
        const outboundReadCount = () =>
          outboundReads.mock.calls.filter((args) => args[2].type === "deliveryQueue.countFailed")
            .length;
        const ingressReads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
        const readCount = (type: string) =>
          ingressReads.mock.calls.filter(([, command]) => command.type === type).length;
        expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
        expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
        expect(outboundReadCount()).toBe(1);
        expect(readCount("channelIngress.failedHealth")).toBe(1);
        expect(readCount("channelIngress.pressureHealth")).toBe(1);

        seedDeliveryQueueEntry({
          queueName: "outbound",
          entry: { id: "failed-outbound", enqueuedAt: 1_000, retryCount: 1 },
          status: "failed",
          stateDir,
        });
        expect(await buildDeliveryQueueHealthSummary()).toEqual({
          failed: [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }],
        });
        expect(outboundReadCount()).toBe(2);
        expect(readCount("channelIngress.failedHealth")).toBe(1);
        expect(readCount("channelIngress.pressureHealth")).toBe(1);

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
        expect(outboundReadCount()).toBe(2);
        expect(readCount("channelIngress.failedHealth")).toBe(2);
        expect(readCount("channelIngress.pressureHealth")).toBe(2);
      },
    );
  });

  it("refreshes pressure at claim expiry after sleep and reloads after restart", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async ({ stateDir }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
      const ingress = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
        now: () => Date.now(),
      });
      await ingress.enqueue("leased", { text: "synthetic" }, { laneKey: "lane" });
      const claim = await ingress.claim("leased", { ownerId: "test" });
      expect(claim).not.toBeNull();
      expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();

      clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS - 1);
      expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
      clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS + 60_000);
      const expired = await buildDeliveryQueueHealthSummary();
      expect(expired?.ingressPressure).toEqual([
        {
          channelId: "telegram",
          accountId: "ops",
          laneCount: 1,
          pendingCount: 0,
          claimedCount: 1,
          blockedCount: 0,
          oldestReceivedAt: 100_000,
        },
      ]);

      await closeOpenClawStateDatabaseAsync();
      const reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
      expect(await buildDeliveryQueueHealthSummary()).toEqual(expired);
      expect(reads.mock.calls.map(([, command]) => command.type)).toEqual([
        "channelIngress.failedHealth",
        "channelIngress.pressureHealth",
      ]);
      await ingress.release(claim!);
      expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
    });
  });

  it.each(["channelIngress.failedHealth", "channelIngress.pressureHealth"])(
    "keeps a queue invalidation received during %s",
    async (heldType) => {
      await withOpenClawTestState({ layout: "state-only" }, async ({ stateDir }) => {
        const ingress = createChannelIngressQueue<{ text: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
          now: () => 1_000,
        });
        await ingress.enqueue("late", { text: "synthetic" }, { laneKey: "lane" });
        const original = stateRead.executeExistingOpenClawStateRead;
        const readFinished = createDeferredCore();
        const releaseRead = createDeferredCore();
        let held = false;
        vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementation(
          async (...args) => {
            const result = await original(...args);
            if (args[1].type === heldType && !held) {
              held = true;
              readFinished.resolve();
              await releaseRead.promise;
            }
            return result;
          },
        );
        const pending = buildDeliveryQueueHealthSummary();
        await readFinished.promise;
        if (heldType === "channelIngress.failedHealth") {
          await ingress.fail("late", { reason: "rejected", failedAt: 2_000 });
        } else {
          expect(await ingress.claim("late", { ownerId: "test" })).not.toBeNull();
        }
        releaseRead.resolve();
        await pending;
        const updated = await buildDeliveryQueueHealthSummary();
        if (heldType === "channelIngress.failedHealth") {
          expect(updated?.ingressFailed).toEqual([
            { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
          ]);
        } else {
          expect(updated?.ingressPressure).toMatchObject([{ laneCount: 1, claimedCount: 1 }]);
        }
      });
    },
  );
});
