import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  restoreQueuedDeliveryCustody,
  stageAndEnqueueOutboundDelivery,
} from "./deliver-queue-admission.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const { spool, retention, storage } = vi.hoisted(() => ({
  spool: { releaseSpoolArtifacts: vi.fn(), stageQueuePayloadMedia: vi.fn() },
  retention: { cancelDeliveryQueueMediaRetention: vi.fn() },
  storage: {
    enqueueDelivery: vi.fn(),
    enqueueDeliveryOnce: vi.fn(),
    enqueuePreparedDeliveryOnce: vi.fn(),
    loadPendingDelivery: vi.fn(),
  },
}));

// mock-isolation: Admission tests control media staging and cleanup without filesystem effects.
vi.mock("./delivery-queue-media-spool.js", () => spool);
// mock-isolation: Retention failures are injected without starting media-retention workers.
vi.mock("./delivery-queue-media-staging.js", () => retention);
// mock-isolation: Admission ordering is checked against controlled storage receipts, not a database.
vi.mock("./delivery-queue-storage.js", () => storage);

const counters = { enqueuedAt: 1, retryCount: 0, attemptCount: 0 };

const payloads = [{ text: "prepared" }];
function enqueue(
  options?: Parameters<typeof stageAndEnqueueOutboundDelivery>[2],
  overrides: Partial<Parameters<typeof stageAndEnqueueOutboundDelivery>[0]> = {},
) {
  return stageAndEnqueueOutboundDelivery(
    { cfg: {}, channel: "matrix", to: "!room:example", payloads, ...overrides },
    createUnmodifiedPreparedOutboundBatch(payloads),
    options,
  );
}

describe("stageAndEnqueueOutboundDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.loadPendingDelivery.mockResolvedValue(null);
  });

  it("restores first custody including absence of a generation binding", () => {
    const params = {
      cfg: {},
      channel: "matrix" as const,
      to: "changed",
      payloads: [{ text: "changed" }],
    };
    const entry = {
      id: "shared-intent",
      ...counters,
      channel: params.channel,
      to: "original",
      preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
    };
    const generation = {
      agentId: "main",
      storePath: "/synthetic/agent.sqlite",
      sessionKey: "agent:main:test",
      sessionId: "original",
      lifecycleRevision: null,
    };
    expect(
      restoreQueuedDeliveryCustody({ ...params, sessionGeneration: generation }, entry),
    ).toMatchObject({
      to: entry.to,
      payloads,
      sessionGeneration: undefined,
    });
    expect(
      restoreQueuedDeliveryCustody(params, { ...entry, sessionGeneration: generation }),
    ).toMatchObject({ to: entry.to, payloads, sessionGeneration: generation });
  });

  it.each(["checkpoint", "staging"])(
    "waits for %s before reading/enqueueing stable custody",
    async (gate) => {
      const snapshot: StableDeliveryPreparation = {
        ...counters,
        id: "stable-1",
        preparationState: "prepared",
        preparationLeaseExpiresAt: 200,
      };
      let current: StableDeliveryPreparation = { ...snapshot, preparationLeaseExpiresAt: 100 };
      const release = createDeferredCore<StableDeliveryPreparation>();
      const entered = createDeferredCore();
      spool.stageQueuePayloadMedia.mockImplementationOnce(async () => {
        if (gate === "staging") {
          await release.promise;
        }
        return { status: "staged", payloads, artifacts: [] };
      });
      storage.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({ id: snapshot.id, created: true });
      const getStablePreparation = vi.fn(async () => {
        entered.resolve();
        return gate === "checkpoint" ? release.promise : current;
      });
      const pending = enqueue(
        { getStablePreparation },
        { queuePolicy: gate === "staging" ? "required" : undefined, deliveryIntentId: snapshot.id },
      );
      if (gate === "staging") {
        await vi.waitFor(() => expect(spool.stageQueuePayloadMedia).toHaveBeenCalledOnce());
        expect(getStablePreparation).not.toHaveBeenCalled();
        current = snapshot;
        release.resolve(snapshot);
      } else {
        await entered.promise;
        expect(storage.enqueuePreparedDeliveryOnce).not.toHaveBeenCalled();
        release.resolve(snapshot);
      }
      await expect(pending).resolves.toEqual({ id: snapshot.id, created: true });
      const queued = storage.enqueuePreparedDeliveryOnce.mock.calls[0];
      expect(queued?.[1]).toBe(snapshot.id);
      expect(queued?.[2]).toBe(snapshot);
    },
  );
  it("preserves admission and independent media cleanup failures", async () => {
    const original = new Error("enqueue failed before publication");
    const cancel = new Error("stage cancellation failed");
    const release = new Error("spool cleanup failed");
    spool.stageQueuePayloadMedia.mockResolvedValueOnce({
      status: "staged",
      payloads,
      artifacts: ["synthetic.ogg"],
      mediaStageId: "synthetic-stage",
    });
    storage.enqueueDelivery.mockRejectedValueOnce(original);
    retention.cancelDeliveryQueueMediaRetention.mockImplementationOnce(() => {
      throw cancel;
    });
    spool.releaseSpoolArtifacts.mockRejectedValueOnce(release);
    await expect(enqueue(undefined, { to: "!synthetic:example" })).rejects.toMatchObject({
      cause: original,
      errors: [original, cancel, release],
    });
  });
});
