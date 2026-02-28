import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { pushHandlers } from "./push.js";

vi.mock("../../infra/push-apns.js", () => ({
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
}));

import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
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
    vi.mocked(sendApnsAlert).mockClear();
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
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
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
});
