import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../process/gateway-work-admission.test-helpers.js";
import { drainPendingDeliveries } from "./delivery-queue-runtime.js";

const mocks = vi.hoisted(() => ({
  coreDrainPendingDeliveries: vi.fn<
    typeof import("../infra/outbound/delivery-queue-recovery.js").drainPendingDeliveriesCore
  >(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => []),
  deliverRuntimeModuleLoads: 0,
}));

vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  drainPendingDeliveriesCore: mocks.coreDrainPendingDeliveries,
}));

vi.mock("../infra/outbound/deliver-runtime.js", () => {
  mocks.deliverRuntimeModuleLoads += 1;
  return {
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
  };
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function drain(deliver?: Parameters<typeof drainPendingDeliveries>[0]["deliver"]) {
  return drainPendingDeliveries({
    drainKey: "demo:test",
    logLabel: "Demo reconnect drain",
    cfg: {},
    log,
    deliver,
    selectEntry: () => ({ match: false }),
  });
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  mocks.coreDrainPendingDeliveries.mockReset().mockResolvedValue(undefined);
  mocks.deliverOutboundPayloads.mockReset().mockResolvedValue([]);
});

afterEach(resetGatewayWorkAdmission);

describe("plugin-sdk delivery queue drainPendingDeliveries", () => {
  it("defers lazy runtime resolution and core draining while suspension is prepared", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const pending = drain();
    await Promise.resolve();

    expect(mocks.deliverRuntimeModuleLoads).toBe(0);
    expect(mocks.coreDrainPendingDeliveries).not.toHaveBeenCalled();

    expect(suspension?.release()).toBe(true);
    await pending;

    expect(mocks.deliverRuntimeModuleLoads).toBe(1);
    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledOnce();
    expect(mocks.coreDrainPendingDeliveries.mock.calls[0]?.[0].deliver).toBe(
      mocks.deliverOutboundPayloads,
    );
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("counts a reconnect drain independently from its admitted parent", async () => {
    const started = createDeferred();
    const finished = createDeferred();
    mocks.coreDrainPendingDeliveries.mockImplementationOnce(() => {
      started.resolve();
      return finished.promise;
    });
    const receipt = { messageId: "queued-message" };
    const deliver = vi.fn(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      return receipt;
    });

    await runWithGatewayRootWorkAdmissionForTest(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const pending = drain(deliver);
      await started.promise;

      try {
        expect(getActiveGatewayRootWorkCount()).toBe(2);
        const params = {
          cfg: {},
          channel: "telegram" as const,
          to: "chat",
          payloads: [{ text: "Queued notice." }],
        };
        const coreDeliver = mocks.coreDrainPendingDeliveries.mock.calls[0]![0].deliver;
        expect(await coreDeliver(params)).toBe(receipt);
        expect(deliver).toHaveBeenCalledExactlyOnceWith(params);
      } finally {
        finished.resolve();
        await pending;
      }
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledOnce();
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    });

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("releases its independent root when the core drain rejects", async () => {
    mocks.coreDrainPendingDeliveries.mockImplementationOnce(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      throw new Error("drain failed");
    });

    await expect(drain(vi.fn(async () => []))).rejects.toThrow("drain failed");

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
