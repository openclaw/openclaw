import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callGatewayMock,
  resolveEffectiveResetTargetSessionKeyMock,
  resolveAcpCommandBindingContextMock,
} = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  resolveEffectiveResetTargetSessionKeyMock: vi.fn<(params: unknown) => unknown>(),
  resolveAcpCommandBindingContextMock: vi.fn<(params: unknown) => unknown>(() => ({
    channel: "thread-chat",
    accountId: "acct",
    conversationId: "conv-1",
    parentConversationId: null,
  })),
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

vi.mock("../acp-reset-target.js", () => ({
  resolveEffectiveResetTargetSessionKey: (params: unknown) =>
    resolveEffectiveResetTargetSessionKeyMock(params),
}));

vi.mock("./context.js", () => ({
  resolveAcpCommandBindingContext: (params: unknown) => resolveAcpCommandBindingContextMock(params),
}));

let resolveAcpTargetSessionKey: typeof import("./targets.js").resolveAcpTargetSessionKey;

describe("resolveAcpTargetSessionKey", () => {
  beforeEach(async () => {
    vi.resetModules();
    callGatewayMock.mockReset();
    resolveEffectiveResetTargetSessionKeyMock.mockReset();
    resolveAcpCommandBindingContextMock.mockClear();
    ({ resolveAcpTargetSessionKey } = await import("./targets.js"));
  });

  it("returns the bound ACP thread session when present", async () => {
    resolveEffectiveResetTargetSessionKeyMock.mockReturnValueOnce("agent:main:bound-session");

    const result = await resolveAcpTargetSessionKey({
      commandParams: {
        cfg: {},
        sessionKey: "agent:main:main",
        ctx: { CommandTargetSessionKey: "" },
      } as never,
    });

    expect(result).toEqual({
      ok: true,
      sessionKey: "agent:main:bound-session",
    });
  });

  it("falls back to requester session key when no token or thread binding exists", async () => {
    resolveEffectiveResetTargetSessionKeyMock.mockReturnValueOnce(undefined);

    const result = await resolveAcpTargetSessionKey({
      commandParams: {
        cfg: { session: { mainKey: "main", scope: "per-sender" } },
        sessionKey: "agent:main:main",
        ctx: { CommandTargetSessionKey: "" },
      } as never,
    });

    expect(result).toEqual({
      ok: true,
      sessionKey: "agent:main:main",
    });
  });
});
