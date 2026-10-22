import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { INGRESS_CLAIM_LEASE_MS } from "../../channels/message/ingress-claim-owner.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "../../channels/message/ingress-retry-policy.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import * as deliveryQueueWorker from "../../infra/delivery-queue-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";

const account = { channelId: "telegram", accountId: "ops" };
const claimedLane = { ...account, laneCount: 1, claimedCount: 1 };
const failedIngress = (oldestFailedAt: number) => [{ ...account, count: 1, oldestFailedAt }];
const createIngress = (stateDir: string, now?: () => number) =>
  createChannelIngressQueue<{ text: string }>({ ...account, stateDir, now });

const it = baseIt.extend<{ stateDir: string }>({
  stateDir: async ({ task: _task }, use) =>
    withOpenClawTestState({ layout: "state-only" }, ({ stateDir }) => use(stateDir)),
});

afterEach(() => vi.restoreAllMocks());

it("surfaces a retry-floor ingress lane with 55 blocked followers", async ({ stateDir }) => {
  const now = Date.now();
  const ingress = createIngress(stateDir, () => now);
  const enqueue = (id: string, text: string, age: number, laneKey = "private-lane") =>
    ingress.enqueue(id, { text }, { laneKey, receivedAt: now - age });
  const claim = async (id: string) =>
    expectDefined(await ingress.claim(id, { ownerId: "private-owner" }), "queue claim");
  await enqueue("retry-head-private", "private payload", 60_000);
  for (let attempt = 0; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt++) {
    await ingress.release(await claim("retry-head-private"), {
      lastError: "private handler error",
      releasedAt: now,
    });
  }
  for (let index = 0; index < 55; index++) {
    await enqueue(`follower-private-${index}`, `private follower ${index}`, 59_000 - index);
  }
  await enqueue("ordinary-retry-private", "ordinary retry", 30_000, "ordinary-private-lane");
  await ingress.release(await claim("ordinary-retry-private"), {
    lastError: "first attempt",
    releasedAt: now,
  });
  await enqueue("fresh-claim-private", "fresh claim", 10_000, "fresh-private-lane");
  await claim("fresh-claim-private");
  const summary = await buildDeliveryQueueHealthSummary();
  expect(summary).toEqual({
    failed: [],
    ingressPressure: [
      {
        ...account,
        laneCount: 1,
        pendingCount: 56,
        claimedCount: 0,
        blockedCount: 55,
        oldestReceivedAt: now - 60_000,
      },
    ],
  });
  expect(JSON.stringify(summary)).not.toMatch(
    /private-lane|private-owner|private payload|private handler error|retry-head-private/,
  );
});

it("invalidates only the changed queue cache", async ({ stateDir }) => {
  openOpenClawStateDatabase();
  const outboundReads = vi.spyOn(deliveryQueueWorker, "executeDeliveryQueueOperation");
  const ingressReads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
  const readCounts = () => [
    outboundReads.mock.calls.filter((args) => args[2].type === "deliveryQueue.countFailed").length,
    ingressReads.mock.calls.filter(([, command]) => command.type === "channelIngress.health")
      .length,
  ];
  const failed = [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }];
  expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
  expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
  expect(readCounts()).toEqual([1, 1]);
  expect(ingressReads).toHaveBeenCalledTimes(1);

  seedDeliveryQueueEntry({
    queueName: "outbound",
    entry: { id: "failed-outbound", enqueuedAt: 1_000, retryCount: 1 },
    status: "failed",
    stateDir,
  });
  expect(await buildDeliveryQueueHealthSummary()).toEqual({ failed });
  expect(readCounts()).toEqual([2, 1]);

  const ingress = createIngress(stateDir);
  await ingress.enqueue("failed-inbound", { text: "synthetic failure" });
  await ingress.fail("failed-inbound", { reason: "rejected", failedAt: 2_000 });
  const updated = await buildDeliveryQueueHealthSummary();
  expect(updated).toEqual({ failed, ingressFailed: failedIngress(2_000) });
  expect(await buildDeliveryQueueHealthSummary()).toEqual(updated);
  expect(readCounts()).toEqual([2, 2]);
});

it("refreshes expired claims after sleep and restart", async ({ stateDir }) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const ingress = createIngress(stateDir, () => Date.now());
  await ingress.enqueue("leased", { text: "synthetic" }, { laneKey: "lane" });
  const claim = await ingress.claim("leased", { ownerId: "test" });
  expect(claim).not.toBeNull();
  await ingress.enqueue("failed", { text: "synthetic failure" });
  await ingress.fail("failed", { reason: "rejected", failedAt: 100_000 });
  const failedOnly = { failed: [], ingressFailed: failedIngress(100_000) };
  const reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
  expect(await buildDeliveryQueueHealthSummary()).toEqual(failedOnly);
  expect(reads).toHaveBeenCalledTimes(1);

  clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS - 1);
  expect(await buildDeliveryQueueHealthSummary()).toEqual(failedOnly);
  clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS + 60_000);
  reads.mockRejectedValueOnce(new Error("health reader unavailable"));
  expect(await buildDeliveryQueueHealthSummary()).toEqual(failedOnly);
  const expired = await buildDeliveryQueueHealthSummary();
  expect(reads).toHaveBeenCalledTimes(3);
  expect(expired?.ingressPressure).toEqual([
    { ...claimedLane, pendingCount: 0, blockedCount: 0, oldestReceivedAt: 100_000 },
  ]);

  await closeOpenClawStateDatabaseAsync();
  reads.mockClear();
  expect(await buildDeliveryQueueHealthSummary()).toEqual(expired);
  expect(reads.mock.calls.map(([, command]) => command.type)).toEqual(["channelIngress.health"]);
  await ingress.release(claim!);
  expect(await buildDeliveryQueueHealthSummary()).toEqual(failedOnly);
});

it.for(["failed", "pressure"])(
  "keeps a %s queue invalidation received during a health read",
  async (healthKind, { stateDir }) => {
    const ingress = createIngress(stateDir, () => 1_000);
    await ingress.enqueue("late", { text: "synthetic" }, { laneKey: "lane" });
    const original = stateRead.executeExistingOpenClawStateRead;
    const readFinished = createDeferredCore();
    const releaseRead = createDeferredCore();
    vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        expect(args[1].type).toBe("channelIngress.health");
        readFinished.resolve();
        await releaseRead.promise;
        return result;
      },
    );
    const pending = buildDeliveryQueueHealthSummary();
    await readFinished.promise;
    if (healthKind === "failed") {
      await ingress.fail("late", { reason: "rejected", failedAt: 2_000 });
    } else {
      expect(await ingress.claim("late", { ownerId: "test" })).not.toBeNull();
    }
    releaseRead.resolve();
    await pending;
    const updated = await buildDeliveryQueueHealthSummary();
    if (healthKind === "failed") {
      expect(updated?.ingressFailed).toEqual(failedIngress(2_000));
    } else {
      expect(updated?.ingressPressure).toMatchObject([claimedLane]);
    }
  },
);
