import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { InternalDeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { deliverOutboundPayloadsWithQueueCleanup } from "./deliver-queue-execute.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { DeliveryProducerLease } from "./delivery-queue-lease.js";

const mocks = vi.hoisted(() => ({
  core: vi.fn(),
  retire: vi.fn(),
  ack: vi.fn(),
  release: vi.fn(),
  terminal: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./deliver-core.js", () => ({ deliverOutboundPayloadsCore: mocks.core }));
vi.mock("./delivery-queue-ack.js", () => ({
  retireUnsentDelivery: mocks.retire,
  ackDelivery: mocks.ack,
}));
vi.mock("./message-sent-hook.js", () => ({
  createOutboundMessageSentEmitter: () => ({
    emitMessageSent: vi.fn(),
    hasMessageSentHooks: false,
  }),
}));
vi.mock("./outbound-audit.js", () => ({
  emitOutboundAuditTerminals: mocks.terminal,
  emitOutboundAuditLifecycle: vi.fn(),
  uniformOutboundAuditTerminals: vi.fn(),
  completedOutboundAuditTerminals: vi.fn(),
  failedOutboundAuditTerminals: vi.fn(),
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

function startDelivery() {
  const controller = new AbortController();
  const core = createDeferredCore<OutboundDeliveryResult[]>();
  const entered = createDeferredCore();
  const stopped = createDeferredCore();
  const stopEntered = createDeferredCore();
  const lease: DeliveryProducerLease = {
    signal: new AbortController().signal,
    stop: vi.fn(() => {
      stopEntered.resolve();
      return stopped.promise;
    }),
  };
  const owner = createQueuedDeliveryOwner({
    queueId: "queued-1",
    expectedPlatformSendAttemptId: "claim-1",
  });
  const params: InternalDeliverOutboundPayloadsParams = {
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "synthetic message" }],
    abortSignal: controller.signal,
    deliveryQueueOwner: owner,
  };
  mocks.core.mockImplementationOnce(async () => {
    entered.resolve();
    return await core.promise;
  });
  const delivery = deliverOutboundPayloadsWithQueueCleanup(params, "queued-1", 1, "claim-1", lease);
  const outcome = delivery.then(
    (results) => ({ results, error: undefined }),
    (error: unknown) => {
      entered.reject(error);
      return { results: undefined, error };
    },
  );
  return { controller, core, entered, stopped, stopEntered, lease, owner, outcome };
}

describe("queued delivery lifecycle joins", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.retire.mockImplementation(() => mocks.release);
    mocks.release.mockResolvedValue(undefined);
    mocks.ack.mockResolvedValue(undefined);
  });

  it("settles the adapter and queue before joining lease stop on cancellation", async () => {
    const run = startDelivery();
    await run.entered.promise;
    run.controller.abort();
    expect(run.owner.custody).toBe("held");
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.terminal).not.toHaveBeenCalled();
    expect(run.lease.stop).not.toHaveBeenCalled();
    run.core.reject(run.controller.signal.reason);
    await run.stopEntered.promise;
    expect(run.owner.custody).toBe("released");
    expect(mocks.ack).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    run.stopped.resolve();
    expect((await run.outcome).error).toMatchObject({ queueCustody: "released" });
    expect(mocks.terminal).toHaveBeenCalledOnce();
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it("reports a rejected lease stop without retrying settled queue cleanup", async () => {
    const run = startDelivery();
    await run.entered.promise;
    run.controller.abort();
    run.core.reject(run.controller.signal.reason);
    await run.stopEntered.promise;
    const failure = new Error("lease stop failed");
    run.stopped.reject(failure);
    expect((await run.outcome).error).toBe(failure);
    expect(run.owner.custody).toBe("released");
    expect(run.lease.stop).toHaveBeenCalledOnce();
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.ack).toHaveBeenCalledOnce();
    expect(mocks.terminal).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
