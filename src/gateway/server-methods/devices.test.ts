import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const {
  getPairedDeviceMock,
  removePairedDeviceMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
} = vi.hoisted(() => ({
  getPairedDeviceMock: vi.fn(),
  removePairedDeviceMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
  rotateDeviceTokenMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    getPairedDevice: getPairedDeviceMock,
    removePairedDevice: removePairedDeviceMock,
    revokeDeviceToken: revokeDeviceTokenMock,
    rotateDeviceToken: rotateDeviceTokenMock,
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
    await Promise.resolve();

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
    await Promise.resolve();

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 456 },
      undefined,
    );
  });

  it("disconnects active clients after rotating a device token", async () => {
    getPairedDeviceMock.mockResolvedValue({
      deviceId: "device-1",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing"],
      tokens: {
        operator: {
          token: "old-token",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 123,
        },
      },
    });
    rotateDeviceTokenMock.mockResolvedValue({
      ok: true,
      entry: {
        token: "new-token",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 456,
        rotatedAtMs: 789,
      },
    });
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: " device-1 ",
        role: " operator ",
        scopes: ["operator.pairing"],
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);
    await Promise.resolve();

    expect(rotateDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
      scopes: ["operator.pairing"],
    });
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      {
        deviceId: " device-1 ",
        role: "operator",
        token: "new-token",
        scopes: ["operator.pairing"],
        rotatedAtMs: 789,
      },
      undefined,
    );
  });

  it("rejects rotating a token for a role that was never approved", async () => {
    getPairedDeviceMock.mockResolvedValue({
      deviceId: "device-1",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing"],
      tokens: {
        operator: {
          token: "old-token",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 123,
        },
      },
    });
    const opts = createOptions(
      "device.token.rotate",
      {
        deviceId: "device-1",
        role: "node",
      },
      {
        client: {
          connect: {
            scopes: ["operator.pairing"],
          },
        } as never,
      },
    );

    await deviceHandlers["device.token.rotate"](opts);

    expect(rotateDeviceTokenMock).not.toHaveBeenCalled();
    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "device token rotation denied" }),
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
