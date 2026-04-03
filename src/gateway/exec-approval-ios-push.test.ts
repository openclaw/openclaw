import { beforeEach, describe, expect, it, vi } from "vitest";

const listDevicePairingMock = vi.fn();
const loadApnsRegistrationMock = vi.fn();
const resolveApnsAuthConfigFromEnvMock = vi.fn();
const resolveApnsRelayConfigFromEnvMock = vi.fn();
const sendApnsExecApprovalAlertMock = vi.fn();
const sendApnsExecApprovalResolvedWakeMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: {} }),
}));

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return {
    ...actual,
    listDevicePairing: listDevicePairingMock,
  };
});

vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistration: loadApnsRegistrationMock,
  resolveApnsAuthConfigFromEnv: resolveApnsAuthConfigFromEnvMock,
  resolveApnsRelayConfigFromEnv: resolveApnsRelayConfigFromEnvMock,
  sendApnsExecApprovalAlert: sendApnsExecApprovalAlertMock,
  sendApnsExecApprovalResolvedWake: sendApnsExecApprovalResolvedWakeMock,
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: [] });
    loadApnsRegistrationMock.mockResolvedValue({
      nodeId: "ios-device-1",
      transport: "direct",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "private-key" },
    });
    resolveApnsRelayConfigFromEnvMock.mockReturnValue({ ok: false, error: "unused" });
    sendApnsExecApprovalAlertMock.mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
    sendApnsExecApprovalResolvedWakeMock.mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [],
      paired: [
        {
          deviceId: "ios-device-1",
          publicKey: "pub",
          platform: "iOS 18",
          role: "operator",
          roles: ["operator"],
          approvedScopes: ["operator.approvals"],
          createdAtMs: 1,
          approvedAtMs: 1,
          tokens: {
            operator: {
              token: "operator-token",
              role: "operator",
              scopes: ["operator.read"],
              createdAtMs: 1,
            },
          },
        },
      ],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      id: "approval-1",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(accepted).toBe(false);
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalAlertMock).not.toHaveBeenCalled();
  });

  it("targets iOS devices when the active operator token includes operator.approvals", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [],
      paired: [
        {
          deviceId: "ios-device-1",
          publicKey: "pub",
          platform: "iOS 18",
          role: "operator",
          roles: ["operator"],
          createdAtMs: 1,
          approvedAtMs: 1,
          tokens: {
            operator: {
              token: "operator-token",
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              createdAtMs: 1,
            },
          },
        },
      ],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const accepted = await delivery.handleRequested({
      id: "approval-2",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(accepted).toBe(true);
    await Promise.resolve();
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalAlertMock).toHaveBeenCalledTimes(1);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved({
      id: "approval-missing-targets",
      decision: "allow-once",
      ts: 1,
    });

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsExecApprovalResolvedWakeMock).not.toHaveBeenCalled();
  });

  it("sends cleanup pushes only to the original request targets", async () => {
    listDevicePairingMock.mockResolvedValue({
      pending: [],
      paired: [
        {
          deviceId: "ios-device-1",
          publicKey: "pub",
          platform: "iOS 18",
          role: "operator",
          roles: ["operator"],
          createdAtMs: 1,
          approvedAtMs: 1,
          tokens: {
            operator: {
              token: "operator-token",
              role: "operator",
              scopes: ["operator.approvals", "operator.read"],
              createdAtMs: 1,
            },
          },
        },
      ],
    });

    const { createExecApprovalIosPushDelivery } = await import("./exec-approval-ios-push.js");
    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    await delivery.handleRequested({
      id: "approval-cleanup",
      request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    await Promise.resolve();
    vi.clearAllMocks();
    loadApnsRegistrationMock.mockResolvedValue({
      nodeId: "ios-device-1",
      transport: "direct",
      token: "apns-token",
      topic: "ai.openclaw.ios.test",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    resolveApnsAuthConfigFromEnvMock.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "private-key" },
    });

    await delivery.handleResolved({
      id: "approval-cleanup",
      decision: "allow-once",
      ts: 1,
    });

    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsExecApprovalResolvedWakeMock).toHaveBeenCalledTimes(1);
  });
});
