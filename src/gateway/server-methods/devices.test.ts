import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { removePairedDeviceMock, revokeDeviceTokenMock } = vi.hoisted(() => ({
  removePairedDeviceMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    removePairedDevice: removePairedDeviceMock,
    revokeDeviceToken: revokeDeviceTokenMock,
  };
});

function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      disconnectClientsForDevice: vi.fn(),
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("deviceHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects active clients after removing a paired device", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1", removedAtMs: 123 });
    const opts = createOptions("device.pair.remove", { deviceId: " device-1 " });

    await deviceHandlers["device.pair.remove"](opts);

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", removedAtMs: 123 },
      undefined,
    );
  });

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await deviceHandlers["device.pair.remove"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId" }),
    );
  });

  it("disconnects active clients after revoking a device token", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ role: "operator", revokedAtMs: 456 });
    const opts = createOptions("device.token.revoke", {
      deviceId: " device-1 ",
      role: " operator ",
    });

    await deviceHandlers["device.token.revoke"](opts);

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1");
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 456 },
      undefined,
    );
  });

  it("does not disconnect clients when token revocation fails", async () => {
    revokeDeviceTokenMock.mockResolvedValue(null);
    const opts = createOptions("device.token.revoke", {
      deviceId: "device-1",
      role: "operator",
    });

    await deviceHandlers["device.token.revoke"](opts);

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId/role" }),
    );
  });
});
