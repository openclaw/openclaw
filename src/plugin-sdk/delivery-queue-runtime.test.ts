import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../process/gateway-work-admission.test-helpers.js";
import { drainPendingDeliveries } from "./delivery-queue-runtime.js";

const mocks = vi.hoisted(() => ({
  drain: vi.fn<
    typeof import("../infra/outbound/delivery-queue-recovery.js").drainPendingDeliveriesCore
  >(async () => {}),
  send: vi.fn(async () => []),
  loads: 0,
}));
vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  drainPendingDeliveriesCore: mocks.drain,
}));
vi.mock("../infra/outbound/deliver-runtime.js", () => {
  mocks.loads += 1;
  return {
    deliverOutboundPayloads: mocks.send,
    deliverOutboundPayloadsInternal: mocks.send,
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
  mocks.drain.mockReset().mockResolvedValue(undefined);
  mocks.send.mockReset().mockResolvedValue([]);
});
afterEach(resetGatewayWorkAdmission);

it("defers lazy runtime resolution and core draining while suspension is prepared", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const pending = drain();
  await Promise.resolve();
  expect(mocks.loads).toBe(0);
  expect(mocks.drain).not.toHaveBeenCalled();
  expect(suspension?.release()).toBe(true);
  await pending;
  expect(mocks.loads).toBe(1);
  expect(mocks.drain).toHaveBeenCalledOnce();
  expect(mocks.drain.mock.calls[0]?.[0].deliver).toBe(mocks.send);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("counts a reconnect drain independently from its admitted parent", async () => {
  const started = createDeferred();
  const finished = createDeferred();
  mocks.drain.mockImplementationOnce(() => {
    started.resolve();
    return finished.promise;
  });
  const deliver = vi.fn(async () => []);
  await runWithGatewayRootWorkAdmissionForTest(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const pending = drain(deliver);
    await started.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    finished.resolve();
    await pending;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(mocks.drain.mock.calls[0]?.[0].deliver).toBe(deliver);
  });
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("releases its independent root when the core drain rejects", async () => {
  mocks.drain.mockImplementationOnce(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    throw new Error("drain failed");
  });
  await expect(drain(vi.fn(async () => []))).rejects.toThrow("drain failed");
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});
