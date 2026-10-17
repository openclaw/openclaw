import { beforeEach, describe, expect, it, vi } from "vitest";
import type { clearDevicePairing } from "../../infra/device-pairing.js";
import { registerGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { bindDeviceWorkerReconciliation } from "../worker-environments/device-provider.js";
import {
  clearDevicePairingMock,
  createOptions,
  resetDeviceHandlerTestState,
} from "./devices.test-support.js";

const { deviceHandlers } = await import("./devices.js");
const clear = deviceHandlers["device.pair.clear"]!;
const committed = {
  removedDevices: ["device-1", "device-2"],
  rejectedRequests: [{ requestId: "repair-1", deviceId: "device-1" }],
};

describe("device pairing clear", () => {
  beforeEach(() => {
    resetDeviceHandlerTestState();
    clearDevicePairingMock.mockReset().mockResolvedValue(committed);
  });

  it("rejects malformed parameters before mutation", async () => {
    const options = createOptions("device.pair.clear", { pending: "yes" });
    await clear(options);
    expect(clearDevicePairingMock).not.toHaveBeenCalled();
    expect(options.respond).toHaveBeenCalledWith(false, undefined, expect.anything());
  });

  it("claims the final reply before commit retires the caller and tears down all removed devices", async () => {
    const options = createOptions("device.pair.clear", { pending: true });
    const client = { invalidated: false, socket: { close: vi.fn() } };
    const response = registerGatewayPolicyResponse("device.pair.clear", client, options.respond);
    const order: string[] = [];
    const workerEnvironmentService = {};
    bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
      order.push(`cleanup:${deviceId}`);
      return [];
    });
    const notify = vi.fn();
    Object.assign(options.context, {
      workerEnvironmentService,
      scopeUpgradeCoordinator: { notify },
      invalidateClientsForDevice: vi.fn((deviceId) => order.push(`invalidate:${deviceId}`)),
      disconnectClientsForDevice: vi.fn((deviceId) => order.push(`disconnect:${deviceId}`)),
    });
    clearDevicePairingMock.mockImplementationOnce(
      async (input: Parameters<typeof clearDevicePairing>[0]) => {
        input.assertCurrent?.();
        expect(response?.pending).toBe(true);
        client.invalidated = true;
        return committed;
      },
    );
    vi.mocked(options.respond).mockImplementation(() => {
      order.push("respond");
    });
    try {
      await clear(options);
      expect(options.respond).toHaveBeenCalledWith(
        true,
        {
          removedDevices: ["device-1", "device-2"],
          rejectedPending: ["repair-1"],
        },
        undefined,
      );
      expect(order).toEqual([
        "invalidate:device-1",
        "invalidate:device-2",
        "cleanup:device-1",
        "cleanup:device-2",
        "respond",
        "disconnect:device-1",
        "disconnect:device-2",
      ]);
      expect(notify).toHaveBeenCalledWith("repair-1", "rejected");
      expect(options.context.broadcast).toHaveBeenCalledWith(
        "device.pair.resolved",
        expect.objectContaining({
          requestId: "repair-1",
          deviceId: "device-1",
          decision: "rejected",
        }),
        { dropIfSlow: true },
      );
    } finally {
      response?.finish();
    }
  });

  it("reports exact committed IDs when one worker cleanup fails and continues remaining teardown", async () => {
    const options = createOptions("device.pair.clear", { pending: true });
    const workerEnvironmentService = {};
    const reconciled: string[] = [];
    bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
      reconciled.push(deviceId);
      if (deviceId === "device-1") {
        throw new Error("synthetic cleanup failure");
      }
      return [];
    });
    Object.assign(options.context, { workerEnvironmentService });
    await clear(options);
    expect(reconciled).toEqual(["device-1", "device-2"]);
    expect(options.respond).toHaveBeenCalledWith(
      true,
      {
        removedDevices: ["device-1", "device-2"],
        rejectedPending: ["repair-1"],
        cleanupFailedDevices: ["device-1"],
      },
      undefined,
    );
    expect(options.context.disconnectClientsForDevice).toHaveBeenCalledTimes(2);
  });
});
