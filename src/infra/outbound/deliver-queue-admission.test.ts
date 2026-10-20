import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  restoreQueuedDeliveryCustody,
  stageAndEnqueueOutboundDelivery,
} from "./deliver-queue-admission.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";
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
    mocks.loadPendingDelivery.mockResolvedValue(null);
  });

  it("restores first custody including absence of a generation binding", () => {
    const originalPayloads = [{ text: "original result" }];
    const entry = {
      id: "shared-intent",
      enqueuedAt: 1,
      retryCount: 0,
      attemptCount: 0,
      channel: "matrix" as const,
      to: "!original:example",
      preparedBatch: createUnmodifiedPreparedOutboundBatch(originalPayloads),
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
      payloads: originalPayloads,
      sessionGeneration: undefined,
    });
    expect(
      restoreQueuedDeliveryCustody(
        { ...params, sessionGeneration: undefined },
        { ...entry, sessionGeneration: generation },
      ),
    ).toMatchObject({ to: entry.to, payloads: originalPayloads, sessionGeneration: generation });
  });

  it("waits for the prepared checkpoint snapshot before enqueue", async () => {
    const snapshot = preparation("stable-checkpoint", 200);
    const checkpoint = createDeferredCore<StableDeliveryPreparation>();
    const entered = createDeferredCore();
    mocks.stageQueuePayloadMedia.mockResolvedValueOnce({
      status: "staged",
      payloads,
      artifacts: [],
    });
    mocks.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({ id: snapshot.id, created: true });
    const pending = enqueue(
      {
        getStablePreparation: () => {
          entered.resolve();
          return checkpoint.promise;
        },
      },
      { deliveryIntentId: snapshot.id },
    );
    await entered.promise;
    const callsBeforeCheckpoint = mocks.enqueuePreparedDeliveryOnce.mock.calls.length;
    checkpoint.resolve(snapshot);
    await expect(pending).resolves.toEqual({ id: snapshot.id, created: true });
    expect(callsBeforeCheckpoint).toBe(0);
    expect(mocks.enqueuePreparedDeliveryOnce.mock.calls[0]?.[2]).toBe(snapshot);
  });

  it("reads the stable preparation after asynchronous media staging", async () => {
    const staging = createDeferredCore();
    mocks.stageQueuePayloadMedia.mockImplementationOnce(async () => {
      await staging.promise;
      return { status: "staged", payloads, artifacts: [] };
    });
    mocks.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({ id: "stable-1", created: true });
    let current = preparation("stable-1", 100);
    const getStablePreparation = vi.fn(async () => current);
    const pending = enqueue(
      { getStablePreparation },
      { queuePolicy: "required", deliveryIntentId: "stable-1" },
    );

    await vi.waitFor(() => expect(mocks.stageQueuePayloadMedia).toHaveBeenCalledOnce());
    expect(getStablePreparation).not.toHaveBeenCalled();
    current = preparation("stable-1", 200);
    staging.resolve();

    await expect(pending).resolves.toEqual({ id: "stable-1", created: true });
    expect(getStablePreparation).toHaveBeenCalledOnce();
    expect(mocks.enqueuePreparedDeliveryOnce).toHaveBeenCalledOnce();
    const queued = mocks.enqueuePreparedDeliveryOnce.mock.calls[0];
    expect(queued?.[1]).toBe("stable-1");
    expect(queued?.[2]).toBe(current);
  });
  it("preserves admission and independent media cleanup failures", async () => {
    const original = new Error("enqueue failed before publication");
    const cancel = new Error("stage cancellation failed");
    const release = new Error("spool cleanup failed");
    mocks.stageQueuePayloadMedia.mockResolvedValueOnce({
      status: "staged",
      payloads,
      artifacts: ["synthetic.ogg"],
      mediaStageId: "synthetic-stage",
    });
    mocks.enqueueDelivery.mockRejectedValueOnce(original);
    mocks.cancelDeliveryQueueMediaRetention.mockImplementationOnce(() => {
      throw cancel;
    });
    mocks.releaseSpoolArtifacts.mockRejectedValueOnce(release);
    await expect(enqueue(undefined, { to: "!synthetic:example" })).rejects.toMatchObject({
      cause: original,
      errors: [original, cancel, release],
    });
  });
});
