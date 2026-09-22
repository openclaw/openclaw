import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { stageAndEnqueueOutboundDelivery } from "./deliver-queue-admission.js";
import type { StableDeliveryPreparation } from "./delivery-queue-preparation.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const mocks = vi.hoisted(() => ({
  cancelDeliveryQueueMediaRetention: vi.fn(),
  enqueueDelivery: vi.fn(),
  enqueueDeliveryOnce: vi.fn(),
  enqueuePreparedDeliveryOnce: vi.fn(),
  loadPendingDelivery: vi.fn(),
  releaseSpoolArtifacts: vi.fn(),
  stageQueuePayloadMedia: vi.fn(),
}));

vi.mock("./delivery-queue-media-spool.js", () => ({
  releaseSpoolArtifacts: mocks.releaseSpoolArtifacts,
  stageQueuePayloadMedia: mocks.stageQueuePayloadMedia,
}));
vi.mock("./delivery-queue-media-staging.js", () => ({
  cancelDeliveryQueueMediaRetention: mocks.cancelDeliveryQueueMediaRetention,
}));
vi.mock("./delivery-queue-storage.js", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
  enqueueDeliveryOnce: mocks.enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce: mocks.enqueuePreparedDeliveryOnce,
  loadPendingDelivery: mocks.loadPendingDelivery,
}));

function preparation(id: string, preparationLeaseExpiresAt: number): StableDeliveryPreparation {
  return {
    id,
    enqueuedAt: 1,
    retryCount: 0,
    attemptCount: 0,
    preparationState: "prepared",
    preparationOwnerId: "owner-1",
    preparationLeaseExpiresAt,
  };
}

describe("stageAndEnqueueOutboundDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPendingDelivery.mockResolvedValue(null);
  });

  it("waits for the prepared checkpoint snapshot before enqueue", async () => {
    const snapshot = preparation("stable-checkpoint", 200);
    const checkpoint = createDeferredCore<StableDeliveryPreparation>();
    const entered = createDeferredCore();
    const payloads = [{ text: "prepared" }];
    mocks.stageQueuePayloadMedia.mockResolvedValueOnce({
      status: "staged",
      payloads,
      artifacts: [],
    });
    mocks.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({ id: snapshot.id, created: true });
    const pending = stageAndEnqueueOutboundDelivery(
      { cfg: {}, channel: "matrix", to: "!room:example", payloads, deliveryIntentId: snapshot.id },
      createUnmodifiedPreparedOutboundBatch(payloads),
      {
        getStablePreparation: () => {
          entered.resolve();
          return checkpoint.promise;
        },
      },
    );
    await entered.promise;
    const callsBeforeCheckpoint = mocks.enqueuePreparedDeliveryOnce.mock.calls.length;
    checkpoint.resolve(snapshot);
    await expect(pending).resolves.toEqual({ id: snapshot.id, created: true });
    expect(callsBeforeCheckpoint).toBe(0);
    expect(mocks.enqueuePreparedDeliveryOnce.mock.calls[0]?.[2]).toBe(snapshot);
  });

  it("reads the stable preparation after asynchronous media staging", async () => {
    let finishStaging: (() => void) | undefined;
    mocks.stageQueuePayloadMedia.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishStaging = () =>
            resolve({
              status: "staged",
              payloads: [{ text: "prepared" }],
              artifacts: [],
            });
        }),
    );
    mocks.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({
      id: "stable-1",
      created: true,
    });
    let current = preparation("stable-1", 100);
    const getStablePreparation = vi.fn(async () => current);
    const payloads = [{ text: "prepared" }];

    const pending = stageAndEnqueueOutboundDelivery(
      {
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads,
        queuePolicy: "required",
        deliveryIntentId: "stable-1",
      },
      createUnmodifiedPreparedOutboundBatch(payloads),
      { getStablePreparation },
    );

    await vi.waitFor(() => expect(mocks.stageQueuePayloadMedia).toHaveBeenCalledOnce());
    expect(getStablePreparation).not.toHaveBeenCalled();
    current = preparation("stable-1", 200);
    finishStaging?.();

    await expect(pending).resolves.toEqual({ id: "stable-1", created: true });
    expect(getStablePreparation).toHaveBeenCalledOnce();
    expect(mocks.enqueuePreparedDeliveryOnce).toHaveBeenCalledOnce();
    const queued = mocks.enqueuePreparedDeliveryOnce.mock.calls[0];
    expect(queued?.[1]).toBe("stable-1");
    expect(queued?.[2]).toBe(current);
  });
});
