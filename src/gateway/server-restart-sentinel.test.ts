import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  consumeRestartSentinel: vi.fn(async () => ({
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
    },
  })),
  formatRestartSentinelMessage: vi.fn(() => "restart message"),
  summarizeRestartSentinel: vi.fn(() => "restart summary"),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  parseSessionThreadInfo: vi.fn(() => ({ baseSessionKey: null, threadId: undefined })),
  loadSessionEntry: vi.fn(() => ({ cfg: {}, entry: {} })),
  resolveAnnounceTargetFromKey: vi.fn(() => null),
  deliveryContextFromSession: vi.fn(() => undefined),
  mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
    ...b,
    ...a,
  })),
  normalizeChannelId: vi.fn((channel: string) => channel),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15550002" })),
  agentCommand: vi.fn(async () => undefined),
  enqueueSystemEvent: vi.fn(),
  defaultRuntime: {},
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: mocks.consumeRestartSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../agents/tools/sessions-send-helpers.js", () => ({
  resolveAnnounceTargetFromKey: mocks.resolveAnnounceTargetFromKey,
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

describe("scheduleRestartSentinelWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls agentCommand with resolved channel, to, and sessionKey after restart", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "restart message",
        sessionKey: "agent:main:main",
        to: "+15550002",
        channel: "whatsapp",
        deliver: true,
        bestEffortDeliver: true,
        messageChannel: "whatsapp",
        accountId: "acct-2",
      }),
      mocks.defaultRuntime,
      {},
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("falls back to enqueueSystemEvent when agentCommand throws", async () => {
    mocks.agentCommand.mockRejectedValueOnce(new Error("agent failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("restart summary"),
      { sessionKey: "agent:main:main" },
    );
  });

  it("falls back to enqueueSystemEvent when channel cannot be resolved (no channel in origin)", async () => {
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("no-target"),
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
  });

  it("falls back to enqueueSystemEvent on main session key when sentinel has no sessionKey", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({ payload: { sessionKey: "" } } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
  });
});
