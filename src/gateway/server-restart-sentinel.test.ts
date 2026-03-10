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
  deliverOutboundPayloads: vi.fn(async () => undefined),
  buildOutboundSessionContext: vi.fn(() => ({ agentId: "main", sessionKey: "agent:main:main" })),
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

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Core two-step delivery + resume flow
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleRestartSentinelWake – two-step delivery + resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers restart notice directly (model-independent) then resumes agent", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    // Step 1: deterministic delivery
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        payloads: [{ text: "restart message" }],
        bestEffort: true,
      }),
    );

    // Step 2: agent resume
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

  it("delivers notification before triggering agent resume (ordering guarantee)", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    const deliverOrder = mocks.deliverOutboundPayloads.mock.invocationCallOrder[0];
    const agentOrder = mocks.agentCommand.mock.invocationCallOrder[0];
    expect(deliverOrder).toBeLessThan(agentOrder);
  });

  it("passes senderIsOwner=false to agentCommand (no privilege escalation)", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    const opts = getArg<Record<string, unknown>>(mocks.agentCommand, 0);
    expect(opts.senderIsOwner).toBe(false);
  });

  it("no-ops when there is no sentinel file", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce(null as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Fallback paths
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleRestartSentinelWake – fallback to enqueueSystemEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to enqueueSystemEvent on main session key when sentinel has no sessionKey", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({ payload: { sessionKey: "" } } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("falls back to enqueueSystemEvent when outbound target cannot be resolved", async () => {
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

  it("falls back to enqueueSystemEvent when channel is missing from merged delivery context", async () => {
    // mergeDeliveryContext is called twice (inner + outer merge); mock the outer to drop channel
    mocks.mergeDeliveryContext
      .mockReturnValueOnce(undefined as never) // inner: sessionDeliveryContext merge
      .mockReturnValueOnce({ to: "+15550002" } as never); // outer: sentinelContext wins, no channel

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
  });

  it("falls back to enqueueSystemEvent when to is missing from merged delivery context", async () => {
    // Mock outer merge to return a context with no `to`
    mocks.mergeDeliveryContext
      .mockReturnValueOnce(undefined as never)
      .mockReturnValueOnce({ channel: "whatsapp" } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
  });

  it("falls back to enqueueSystemEvent (with error) when agentCommand throws", async () => {
    mocks.agentCommand.mockRejectedValueOnce(new Error("agent failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    // Direct delivery should still have been attempted
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalled();
    // Then fallback for the resume
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("restart summary"),
      { sessionKey: "agent:main:main" },
    );
  });

  it("still calls agentCommand even if deliverOutboundPayloads throws (bestEffort guard)", async () => {
    // bestEffort: true means it shouldn't normally throw, but even if it does, resume continues
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("deliver failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.agentCommand).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — Thread routing (Slack vs non-Slack)
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleRestartSentinelWake – thread routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps threadId to replyToId and clears threadId for Slack deliverOutboundPayloads", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: { channel: "slack", to: "C012AB3CD", accountId: "acct-2" },
        threadId: "1234567890.123456",
      },
    } as never);
    mocks.normalizeChannelId.mockReturnValueOnce("slack");

    await scheduleRestartSentinelWake({ deps: {} as never });

    const deliverArgs = getArg<Record<string, unknown>>(mocks.deliverOutboundPayloads, 0);
    expect(deliverArgs.replyToId).toBe("1234567890.123456");
    expect(deliverArgs.threadId).toBeUndefined();
  });

  it("passes threadId directly (not replyToId) for non-Slack channels", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: { channel: "discord", to: "123456789", accountId: "acct-2" },
        threadId: "discord-thread-id",
      },
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    const deliverArgs = getArg<Record<string, unknown>>(mocks.deliverOutboundPayloads, 0);
    expect(deliverArgs.threadId).toBe("discord-thread-id");
    expect(deliverArgs.replyToId).toBeUndefined();
  });

  it("passes threadId to agentCommand for non-Slack threading", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: { channel: "discord", to: "123456789", accountId: "acct-2" },
        threadId: "discord-thread-id",
      },
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    const agentOpts = getArg<Record<string, unknown>>(mocks.agentCommand, 0);
    expect(agentOpts.threadId).toBe("discord-thread-id");
  });

  it("sentinel payload threadId takes precedence over session-derived threadId", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: { channel: "whatsapp", to: "+15550002", accountId: "acct-2" },
        threadId: "sentinel-thread",
      },
    } as never);
    // parseSessionThreadInfo would derive a different threadId from the session key
    mocks.parseSessionThreadInfo.mockReturnValueOnce({
      baseSessionKey: null,
      threadId: "session-thread",
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    const agentOpts = getArg<Record<string, unknown>>(mocks.agentCommand, 0);
    expect(agentOpts.threadId).toBe("sentinel-thread");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Delivery context priority: sentinel > session store > parsed target
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleRestartSentinelWake – delivery context priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers sentinel deliveryContext over session store (handles heartbeat-overwritten store)", async () => {
    // Session store has been overwritten with heartbeat sink
    mocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "webchat",
      to: "heartbeat",
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    // agentCommand should use the sentinel's whatsapp/+15550002, not webchat/heartbeat
    const agentOpts = getArg<Record<string, unknown>>(mocks.agentCommand, 0);
    expect(agentOpts.channel).toBe("whatsapp");
    expect(agentOpts.to).toBe("+15550002");
  });

  it("falls back to session store when sentinel has no deliveryContext", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: { sessionKey: "agent:main:main" }, // no deliveryContext
    } as never);
    mocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "telegram",
      to: "+19990001",
    } as never);
    // Mock both merge calls: inner produces session ctx; outer passes it through
    mocks.mergeDeliveryContext
      .mockReturnValueOnce({ channel: "telegram", to: "+19990001" } as never) // inner
      .mockReturnValueOnce({ channel: "telegram", to: "+19990001" } as never); // outer
    // resolveOutboundTarget must reflect the session-store to value
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true as const, to: "+19990001" });

    await scheduleRestartSentinelWake({ deps: {} as never });

    const agentOpts = getArg<Record<string, unknown>>(mocks.agentCommand, 0);
    expect(agentOpts.channel).toBe("telegram");
    expect(agentOpts.to).toBe("+19990001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getArg<T>(mockFn: { mock: { calls: unknown[][] } }, argIdx: number): T {
  return mockFn.mock.calls[0]?.[argIdx] as T;
}
