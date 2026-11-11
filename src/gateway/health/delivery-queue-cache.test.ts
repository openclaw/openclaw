import { afterEach, expect, it as baseIt, vi } from "vitest";
import { INGRESS_CLAIM_LEASE_MS } from "../../channels/message/ingress-claim-owner.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildDeliveryQueueHealthSummary as readHealth } from "./delivery-queue.js";

const account = { channelId: "telegram", accountId: "ops" };
const claimedLane = { ...account, laneCount: 1, claimedCount: 1 };
const failedIngress = (oldestFailedAt: number) => [{ ...account, count: 1, oldestFailedAt }];
const createIngress = (stateDir: string, now?: () => number) =>
  createChannelIngressQueue<{ text: string }>({ ...account, stateDir, now });
const spyOnIngress = () => vi.spyOn(stateRead, "executeExistingOpenClawStateRead");

const it = baseIt.extend<{ stateDir: string }>({
  stateDir: async ({ task: _task }, use) =>
    withOpenClawTestState({ layout: "state-only" }, ({ stateDir }) => use(stateDir)),
});

afterEach(() => vi.restoreAllMocks());

it("keeps ingress health cached across outbound changes", async ({ stateDir }) => {
  openOpenClawStateDatabase();
  const reads = spyOnIngress();
  expect(await readHealth()).toBeUndefined();
  seedDeliveryQueueEntry({
    queueName: "outbound",
    entry: { id: "failed-outbound", enqueuedAt: 1_000, retryCount: 1 },
    status: "failed",
    stateDir,
  });
  expect(await readHealth()).toEqual({
    failed: [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }],
  });
  expect(reads).toHaveBeenCalledTimes(1);
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
  const reads = spyOnIngress();
  expect(await readHealth()).toEqual(failedOnly);

  clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS - 1);
  expect(await readHealth()).toEqual(failedOnly);
  clock.mockReturnValue(100_000 + INGRESS_CLAIM_LEASE_MS + 60_000);
  reads.mockRejectedValueOnce(new Error("health reader unavailable"));
  expect(await readHealth()).toEqual(failedOnly);
  const expired = await readHealth();
  expect(reads).toHaveBeenCalledTimes(3);
  expect(expired?.ingressPressure).toEqual([
    { ...claimedLane, pendingCount: 0, blockedCount: 0, oldestReceivedAt: 100_000 },
  ]);

  await closeOpenClawStateDatabaseAsync();
  expect(await readHealth()).toEqual(expired);
  expect(reads).toHaveBeenCalledTimes(4);
  await ingress.release(claim!);
  expect(await readHealth()).toEqual(failedOnly);
});

it.for(["failed", "pressure"])("retains %s invalidations", async (kind, { stateDir }) => {
  const ingress = createIngress(stateDir, () => 1_000);
  await ingress.enqueue("late", { text: "synthetic" }, { laneKey: "lane" });
  const original = stateRead.executeExistingOpenClawStateRead;
  const readFinished = createDeferredCore();
  const releaseRead = createDeferredCore();
  spyOnIngress().mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    readFinished.resolve();
    await releaseRead.promise;
    return result;
  });
  const pending = readHealth();
  await readFinished.promise;
  if (kind === "failed") {
    await ingress.fail("late", { reason: "rejected", failedAt: 2_000 });
  } else {
    expect(await ingress.claim("late", { ownerId: "test" })).not.toBeNull();
  }
  releaseRead.resolve();
  await pending;
  const updated = await readHealth();
  if (kind === "failed") {
    expect(updated?.ingressFailed).toEqual(failedIngress(2_000));
  } else {
    expect(updated?.ingressPressure).toMatchObject([claimedLane]);
  }
});
