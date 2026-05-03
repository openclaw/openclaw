import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadApnsRegistrationMock = vi.fn();
const resolveApnsAuthConfigFromEnvMock = vi.fn();
const resolveApnsRelayConfigFromEnvMock = vi.fn();
const sendApnsAlertMock = vi.fn();
const clearApnsRegistrationIfCurrentMock = vi.fn();
const shouldClearStoredApnsRegistrationMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: {}, session: { mainKey: "main" } })),
}));

vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistration: loadApnsRegistrationMock,
  resolveApnsAuthConfigFromEnv: resolveApnsAuthConfigFromEnvMock,
  resolveApnsRelayConfigFromEnv: resolveApnsRelayConfigFromEnvMock,
  sendApnsAlert: sendApnsAlertMock,
  clearApnsRegistrationIfCurrent: clearApnsRegistrationIfCurrentMock,
  shouldClearStoredApnsRegistration: shouldClearStoredApnsRegistrationMock,
}));

describe("maybeSendChatReplyApnsAlert", () => {
  let maybeSendChatReplyApnsAlert: (typeof import("./chat-apns-notify.js"))["maybeSendChatReplyApnsAlert"];

  beforeAll(async () => {
    ({ maybeSendChatReplyApnsAlert } = await import("./chat-apns-notify.js"));
  });

  beforeEach(() => {
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
    resolveApnsRelayConfigFromEnvMock.mockReturnValue({ ok: false, error: "unused" });
    sendApnsAlertMock.mockResolvedValue({
      ok: true,
      status: 200,
      environment: "sandbox",
      topic: "ai.openclaw.ios.test",
      tokenSuffix: "token",
      transport: "direct",
    });
    shouldClearStoredApnsRegistrationMock.mockReturnValue(false);
  });

  it("sends APNs alert for offline main-session reply devices", async () => {
    await maybeSendChatReplyApnsAlert({
      sessionKey: "main",
      requestDeviceId: "ios-device-1",
      requestConnId: "conn-1",
      replyText: "  long\n\nreply body  ",
      isConnIdConnected: () => false,
      hasConnectedClientForDevice: () => false,
    });

    expect(loadApnsRegistrationMock).toHaveBeenCalledWith("ios-device-1");
    expect(sendApnsAlertMock).toHaveBeenCalledTimes(1);
    expect(sendApnsAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-device-1",
        title: "OpenClaw",
        body: "long reply body",
      }),
    );
  });

  it("skips APNs while the requester connection is still active", async () => {
    await maybeSendChatReplyApnsAlert({
      sessionKey: "main",
      requestDeviceId: "ios-device-1",
      requestConnId: "conn-1",
      replyText: "reply body",
      isConnIdConnected: () => true,
      hasConnectedClientForDevice: () => false,
    });

    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsAlertMock).not.toHaveBeenCalled();
  });

  it("skips APNs for non-main sessions", async () => {
    await maybeSendChatReplyApnsAlert({
      sessionKey: "subagent:demo",
      requestDeviceId: "ios-device-1",
      requestConnId: "conn-1",
      replyText: "reply body",
      isConnIdConnected: () => false,
      hasConnectedClientForDevice: () => false,
    });

    expect(loadApnsRegistrationMock).not.toHaveBeenCalled();
    expect(sendApnsAlertMock).not.toHaveBeenCalled();
  });
});
