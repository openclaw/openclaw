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

vi.mock("./delivery-queue-media-spool.js", () => spool);
vi.mock("./delivery-queue-media-staging.js", () => retention);
vi.mock("./delivery-queue-storage.js", () => storage);

const counters = { enqueuedAt: 1, retryCount: 0, attemptCount: 0 };
function preparation(id: string, preparationLeaseExpiresAt: number): StableDeliveryPreparation {
  return {
    id,
    ...counters,
    preparationState: "prepared",
    preparationLeaseExpiresAt,
  };
}

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
    const entry = {
      id: "shared-intent",
      ...counters,
      channel: "matrix" as const,
      to: "!original:example",
      preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
    };
    const generation = {
      agentId: "main",
      storePath: "/synthetic/agent.sqlite",
      sessionKey: "agent:main:test",
      sessionId: "original",
      lifecycleRevision: null,
    };
    const params = {
      cfg: {},
      channel: "matrix" as const,
      to: "!changed:example",
      payloads: [{ text: "changed" }],
      sessionGeneration: generation,
    };
    expect(restoreQueuedDeliveryCustody(params, entry)).toMatchObject({
      to: entry.to,
      payloads,
      sessionGeneration: undefined,
    });
    expect(
      restoreQueuedDeliveryCustody(
        { ...params, sessionGeneration: undefined },
        { ...entry, sessionGeneration: generation },
      ),
    ).toMatchObject({ to: entry.to, payloads, sessionGeneration: generation });
  });

  it.each(["checkpoint", "staging"])(
    "waits for %s before reading/enqueueing stable custody",
    async (gate) => {
      const snapshot = preparation("stable-1", 200);
      let current = preparation(snapshot.id, 100);
      const staging = createDeferredCore();
      const checkpoint = createDeferredCore<StableDeliveryPreparation>();
      const entered = createDeferredCore();
      spool.stageQueuePayloadMedia.mockImplementationOnce(async () => {
        if (gate === "staging") {
          await staging.promise;
        }
        return { status: "staged", payloads, artifacts: [] };
      });
      storage.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({ id: snapshot.id, created: true });
      const getStablePreparation = vi.fn(async () => {
        entered.resolve();
        return gate === "checkpoint" ? checkpoint.promise : current;
      });
      const pending = enqueue(
        { getStablePreparation },
        { queuePolicy: gate === "staging" ? "required" : undefined, deliveryIntentId: snapshot.id },
      );
      if (gate === "staging") {
        await vi.waitFor(() => expect(spool.stageQueuePayloadMedia).toHaveBeenCalledOnce());
        expect(getStablePreparation).not.toHaveBeenCalled();
        current = snapshot;
        staging.resolve();
      } else {
        await entered.promise;
        expect(storage.enqueuePreparedDeliveryOnce).not.toHaveBeenCalled();
        checkpoint.resolve(snapshot);
      }
      await expect(pending).resolves.toEqual({ id: snapshot.id, created: true });
      expect(getStablePreparation).toHaveBeenCalledOnce();
      expect(storage.enqueuePreparedDeliveryOnce).toHaveBeenCalledOnce();
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
