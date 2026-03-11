import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { pushHandlers } from "./push.js";

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistration: vi.fn(),
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(),
}));

import {
  clearApnsRegistration,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await pushHandlers["push.test"]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: "push.test" },
        isWebchatConnect: () => false,
      }),
  };
}

function expectInvalidRequestResponse(
  respond: ReturnType<typeof vi.fn>,
  expectedMessagePart: string,
) {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(expectedMessagePart);
}

describe("push.test handler", () => {
  beforeEach(() => {
    vi.mocked(loadApnsRegistration).mockClear();
    vi.mocked(normalizeApnsEnvironment).mockClear();
    vi.mocked(resolveApnsAuthConfigFromEnv).mockClear();
    vi.mocked(resolveApnsRelayConfigFromEnv).mockClear();
    vi.mocked(sendApnsAlert).mockClear();
    vi.mocked(clearApnsRegistration).mockClear();
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ title: "hello" });
    await invoke();
    expectInvalidRequestResponse(respond, "invalid push.test params");
  });

  it("returns invalid request when node has no APNs registration", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(null);
    const { respond, invoke } = createInvokeParams({ nodeId: "ios-node-1" });
    await invoke();
    expectInvalidRequestResponse(respond, "has no APNs registration");
  });

  it("sends push test when registration and auth are available", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      transport: "direct",
      token: "abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
      ok: true,
      value: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });

    const { respond, invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, status: 200 });
  });

  it("sends push test through relay registrations", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      transport: "relay",
      relayHandle: "relay-handle-123",
      installationId: "install-1",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      updatedAtMs: 1,
      tokenDebugSuffix: "abcd1234",
    });
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        authToken: "relay-secret",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "abcd1234",
      topic: "ai.openclaw.ios",
      environment: "production",
      transport: "relay",
    });

    const { respond, invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(resolveApnsAuthConfigFromEnv).not.toHaveBeenCalled();
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, status: 200, transport: "relay" });
  });

  it("clears stale registrations after invalid token push-test failures", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      transport: "direct",
      token: "abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
      ok: true,
      value: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(true);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(clearApnsRegistration).toHaveBeenCalledWith("ios-node-1");
  });

  it("does not clear relay registrations after invalidation-shaped failures", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      transport: "relay",
      relayHandle: "relay-handle-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      updatedAtMs: 1,
      tokenDebugSuffix: "abcd1234",
    });
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        authToken: "relay-secret",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: false,
      status: 410,
      reason: "Unregistered",
      tokenSuffix: "abcd1234",
      topic: "ai.openclaw.ios",
      environment: "production",
      transport: "relay",
    });
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration: {
        nodeId: "ios-node-1",
        transport: "relay",
        relayHandle: "relay-handle-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        updatedAtMs: 1,
        tokenDebugSuffix: "abcd1234",
      },
      result: {
        ok: false,
        status: 410,
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      },
      overrideEnvironment: null,
    });
    expect(clearApnsRegistration).not.toHaveBeenCalled();
  });

  it("does not clear direct registrations when push.test overrides the environment", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue({
      nodeId: "ios-node-1",
      transport: "direct",
      token: "abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 1,
    });
    vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
      ok: true,
      value: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue("production");
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "production",
      transport: "direct",
    });
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
      environment: "production",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration: {
        nodeId: "ios-node-1",
        transport: "direct",
        token: "abcd",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        updatedAtMs: 1,
      },
      result: {
        ok: false,
        status: 400,
        reason: "BadDeviceToken",
        tokenSuffix: "1234abcd",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "direct",
      },
      overrideEnvironment: "production",
    });
    expect(clearApnsRegistration).not.toHaveBeenCalled();
  });
});
