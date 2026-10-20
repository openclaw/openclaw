import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ingressHealth from "../../channels/message/ingress-queue-health.js";
import * as deliveryQueueState from "../../infra/delivery-queue-sqlite.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "/tmp/queue-health-sessions" } }),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/queue-health-sessions",
}));

vi.mock("../../config/sessions/session-entry-read-runtime.js", async () => {
  const { createSessionStoreSummaryReaderStub } =
    await import("../../config/sessions/session-store-summary.test-support.js");
  return { withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub() };
});

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const [collector, pluginRuntime, degradedState] = await Promise.all([
  import("./collector.js"),
  import("../../plugins/runtime.js"),
  import("../../plugins/runtime-degraded-state.js"),
]);
const pluginRegistrySnapshot = pluginRuntime.captureActivePluginRegistrySnapshot();
const degradedPluginsSnapshot = degradedState.listActiveDegradedPlugins();
const collectHealth = () =>
  collector.collectGatewayHealthSnapshot({ audience: "admin", probe: false });

describe("queue health collector", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    pluginRuntime.setActivePluginRegistry(createEmptyPluginRegistry());
    degradedState.setActiveDegradedPlugins([]);
  });

  afterAll(() => {
    pluginRuntime.restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
    degradedState.setActiveDegradedPlugins(degradedPluginsSnapshot);
  });

  it("preserves the health snapshot when outbound admission capture fails", async () => {
    const capture = vi
      .spyOn(deliveryQueueState, "captureDeliveryQueueStateContext")
      .mockImplementation(() => {
        throw new Error("outbound admission unavailable");
      });
    const countOutbound = vi.spyOn(deliveryQueueState, "countFailedDeliveryQueueEntries");
    const failed = [{ channelId: "telegram", accountId: "ops", count: 1 }];
    vi.spyOn(ingressHealth, "countChannelIngressQueueHealth").mockResolvedValue({
      failed,
      pressure: [],
    });
    const pending = collectHealth();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({
      channels: {},
      deliveryQueues: { failed: [], ingressFailed: failed },
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(countOutbound).not.toHaveBeenCalled();
  });

  it("surfaces a retry-floor ingress lane with 55 blocked followers", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { createChannelIngressQueue } = await import("../../channels/message/ingress-queue.js");
      const { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } =
        await import("../../channels/message/ingress-retry-policy.js");
      const now = Date.now();
      const ingressQueue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        now: () => now,
      });
      const enqueue = (id: string, text: string, laneKey: string, age: number) =>
        ingressQueue.enqueue(id, { text }, { laneKey, receivedAt: now - age });
      const claim = async (id: string) =>
        expectDefined(await ingressQueue.claim(id, { ownerId: "private-owner" }), "queue claim");
      await enqueue("retry-head-private", "private payload", "private-lane", 60_000);
      for (let attempt = 0; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        await ingressQueue.release(await claim("retry-head-private"), {
          lastError: "private handler error",
          releasedAt: now,
        });
      }
      for (let index = 0; index < 55; index += 1) {
        await enqueue(
          `follower-private-${index}`,
          `private follower ${index}`,
          "private-lane",
          59_000 - index,
        );
      }
      await enqueue("ordinary-retry-private", "ordinary retry", "ordinary-private-lane", 30_000);
      await ingressQueue.release(await claim("ordinary-retry-private"), {
        lastError: "first attempt",
        releasedAt: now,
      });
      await enqueue("fresh-claim-private", "fresh claim", "fresh-private-lane", 10_000);
      await claim("fresh-claim-private");

      const snap = await collectHealth();
      expect(snap.deliveryQueues).toEqual({
        failed: [],
        ingressPressure: [
          {
            channelId: "telegram",
            accountId: "ops",
            laneCount: 1,
            pendingCount: 56,
            claimedCount: 0,
            blockedCount: 55,
            oldestReceivedAt: now - 60_000,
          },
        ],
      });
      expect(JSON.stringify(snap.deliveryQueues)).not.toMatch(
        /private-lane|private-owner|private payload|private handler error|retry-head-private/,
      );
    });
  });
});
