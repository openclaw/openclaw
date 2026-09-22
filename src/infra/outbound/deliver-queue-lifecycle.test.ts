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
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));
vi.mock("./message-sent-hook.js", () => ({
  createMessageSentEmitter: () => ({ emitMessageSent: vi.fn(), hasMessageSentHooks: false }),
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
    (error: unknown) => ({ results: undefined, error }),
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

  it("joins lease stop before cancellation retires custody and later releases preparation", async () => {
    const retired = createDeferredCore();
    mocks.terminal.mockImplementationOnce(() => retired.resolve());
    const run = startDelivery();
    await run.entered.promise;
    run.controller.abort();
    await run.stopEntered.promise;
    expect(run.owner.custody).toBe("held");
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.terminal).not.toHaveBeenCalled();
    run.stopped.resolve();
    await retired.promise;
    expect(run.owner.custody).toBe("released");
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    run.core.reject(run.controller.signal.reason);
    expect((await run.outcome).error).toMatchObject({ queueCustody: "released" });
    expect(mocks.terminal).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.ack).not.toHaveBeenCalled();
  });

  it("retains custody and reports a rejected stop without retrying retirement or cleanup", async () => {
    const run = startDelivery();
    await run.entered.promise;
    run.controller.abort();
    await run.stopEntered.promise;
    const failure = new Error("lease stop failed");
    run.stopped.reject(failure);
    run.core.reject(run.controller.signal.reason);
    expect((await run.outcome).error).toMatchObject({ cause: failure, queueCustody: "held" });
    expect(run.owner.custody).toBe("held");
    expect(run.lease.stop).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("lease stop failed"));
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(mocks.terminal).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
