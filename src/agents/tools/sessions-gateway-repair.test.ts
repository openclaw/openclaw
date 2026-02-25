import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevicePairingPendingRequest } from "../../infra/device-pairing.js";

// Use vi.hoisted to make mocks accessible in factory functions
const {
  callGateway,
  listDevicePairing,
  approveDevicePairing,
  loadOrCreateDeviceIdentity,
  isLocalLoopbackGateway,
} = vi.hoisted(() => ({
  callGateway: vi.fn(),
  listDevicePairing: vi.fn(),
  approveDevicePairing: vi.fn(),
  loadOrCreateDeviceIdentity: vi.fn(),
  isLocalLoopbackGateway: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway,
  isLocalLoopbackGateway,
}));

vi.mock("../../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity,
}));

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing,
  approveDevicePairing,
}));

// Import after mocks are set up
const {
  GatewayRepairError,
  callGatewayWithRepairApproval,
  findRepairCandidate,
  isPairingRequiredError,
} = await import("./sessions-gateway-repair.js");

describe("isPairingRequiredError", () => {
  it("returns true for pairing required in message", () => {
    const err = new Error("gateway closed (1008): pairing required");
    expect(isPairingRequiredError(err)).toBe(true);
  });

  it("returns true for 1008 with pairing in message", () => {
    const err = new Error("gateway closed (1008): some pairing context");
    expect(isPairingRequiredError(err)).toBe(true);
  });

  it("returns false for other errors", () => {
    const err = new Error("gateway closed (1008): unauthorized");
    expect(isPairingRequiredError(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isPairingRequiredError("string error")).toBe(false);
    expect(isPairingRequiredError(null)).toBe(false);
    expect(isPairingRequiredError(undefined)).toBe(false);
  });
});

describe("findRepairCandidate", () => {
  const localDeviceId = "test-device-id";
  const now = Date.now();

  it("finds repair candidate matching all criteria", () => {
    const pending: DevicePairingPendingRequest[] = [
      {
        requestId: "req-1",
        deviceId: localDeviceId,
        role: "operator",
        isRepair: true,
        ts: now - 10_000,
        publicKey: "test-key",
      },
    ];
    const result = findRepairCandidate(pending, localDeviceId, now);
    expect(result?.requestId).toBe("req-1");
  });

  it("returns null when isRepair is false", () => {
    const pending: DevicePairingPendingRequest[] = [
      {
        requestId: "req-1",
        deviceId: localDeviceId,
        role: "operator",
        isRepair: false,
        ts: now - 10_000,
        publicKey: "test-key",
      },
    ];
    const result = findRepairCandidate(pending, localDeviceId, now);
    expect(result).toBeNull();
  });

  it("returns null when deviceId does not match", () => {
    const pending: DevicePairingPendingRequest[] = [
      {
        requestId: "req-1",
        deviceId: "other-device",
        role: "operator",
        isRepair: true,
        ts: now - 10_000,
        publicKey: "test-key",
      },
    ];
    const result = findRepairCandidate(pending, localDeviceId, now);
    expect(result).toBeNull();
  });

  it("returns null when role is not operator", () => {
    const pending: DevicePairingPendingRequest[] = [
      {
        requestId: "req-1",
        deviceId: localDeviceId,
        role: "viewer",
        isRepair: true,
        ts: now - 10_000,
        publicKey: "test-key",
      },
    ];
    const result = findRepairCandidate(pending, localDeviceId, now);
    expect(result).toBeNull();
  });

  it("returns null when request is older than 120s", () => {
    const pending: DevicePairingPendingRequest[] = [
      {
        requestId: "req-1",
        deviceId: localDeviceId,
        role: "operator",
        isRepair: true,
        ts: now - 200_000,
        publicKey: "test-key",
      },
    ];
    const result = findRepairCandidate(pending, localDeviceId, now);
    expect(result).toBeNull();
  });

  it("returns null when no pending requests", () => {
    const result = findRepairCandidate([], localDeviceId, now);
    expect(result).toBeNull();
  });
});

describe("callGatewayWithRepairApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result directly when callGateway succeeds", async () => {
    callGateway.mockResolvedValue({ ok: true });

    const result = await callGatewayWithRepairApproval({ method: "health" });

    expect(result).toEqual({ ok: true });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("rethrows non-pairing errors", async () => {
    const error = new Error("gateway closed (1006): abnormal closure");
    callGateway.mockRejectedValue(error);

    await expect(callGatewayWithRepairApproval({ method: "health" })).rejects.toThrow(
      "abnormal closure",
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("rethrows pairing error in remote mode", async () => {
    const error = new Error("gateway closed (1008): pairing required");
    callGateway.mockRejectedValue(error);
    isLocalLoopbackGateway.mockReturnValue(false);

    await expect(callGatewayWithRepairApproval({ method: "health" })).rejects.toThrow(
      "pairing required",
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(listDevicePairing).not.toHaveBeenCalled();
  });

  it("throws GatewayRepairError when no repair candidate found", async () => {
    const error = new Error("gateway closed (1008): pairing required");
    callGateway.mockRejectedValue(error);
    isLocalLoopbackGateway.mockReturnValue(true);
    listDevicePairing.mockResolvedValue({ pending: [], paired: [] });
    loadOrCreateDeviceIdentity.mockReturnValue({ deviceId: "test-device-id" });

    await expect(callGatewayWithRepairApproval({ method: "health" })).rejects.toThrow(
      GatewayRepairError,
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("auto-approves and retries when repair candidate found", async () => {
    const error = new Error("gateway closed (1008): pairing required");
    callGateway.mockRejectedValueOnce(error).mockResolvedValueOnce({ ok: true, sessions: [] });
    isLocalLoopbackGateway.mockReturnValue(true);
    loadOrCreateDeviceIdentity.mockReturnValue({ deviceId: "test-device-id" });
    const now = Date.now();
    listDevicePairing.mockResolvedValue({
      pending: [
        {
          requestId: "req-1",
          deviceId: "test-device-id",
          role: "operator",
          isRepair: true,
          ts: now - 10_000,
          publicKey: "test-key",
        },
      ],
      paired: [],
    });
    approveDevicePairing.mockResolvedValue({
      requestId: "req-1",
      device: { deviceId: "test-device-id" },
    });

    const result = await callGatewayWithRepairApproval({ method: "sessions.list" });

    expect(result).toEqual({ ok: true, sessions: [] });
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(approveDevicePairing).toHaveBeenCalledWith("req-1", undefined);
  });

  it("propagates error when retry also fails", async () => {
    const error = new Error("gateway closed (1008): pairing required");
    const retryError = new Error("gateway closed (1008): pairing required");
    callGateway.mockRejectedValueOnce(error).mockRejectedValueOnce(retryError);
    isLocalLoopbackGateway.mockReturnValue(true);
    loadOrCreateDeviceIdentity.mockReturnValue({ deviceId: "test-device-id" });
    const now = Date.now();
    listDevicePairing.mockResolvedValue({
      pending: [
        {
          requestId: "req-1",
          deviceId: "test-device-id",
          role: "operator",
          isRepair: true,
          ts: now - 10_000,
          publicKey: "test-key",
        },
      ],
      paired: [],
    });
    approveDevicePairing.mockResolvedValue({
      requestId: "req-1",
      device: { deviceId: "test-device-id" },
    });

    await expect(callGatewayWithRepairApproval({ method: "health" })).rejects.toThrow(
      "pairing required",
    );
    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
