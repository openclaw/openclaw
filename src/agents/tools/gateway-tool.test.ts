import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isRestartEnabled: vi.fn(() => true),
  resolveConfigSnapshotHash: vi.fn(() => undefined),
  extractDeliveryInfo: vi.fn(() => ({
    deliveryContext: { channel: "telegram", to: "+19995550001", accountId: undefined },
    threadId: undefined,
  })),
  writeRestartSentinel: vi.fn(async () => undefined),
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ ok: true })),
  formatDoctorNonInteractiveHint: vi.fn(() => ""),
  callGatewayTool: vi.fn(async () => ({})),
  readGatewayCallOptions: vi.fn(() => ({})),
  resolveGatewayTarget: vi.fn(() => undefined),
}));

vi.mock("../../config/commands.js", () => ({ isRestartEnabled: mocks.isRestartEnabled }));
vi.mock("../../config/io.js", () => ({
  resolveConfigSnapshotHash: mocks.resolveConfigSnapshotHash,
}));
vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  writeRestartSentinel: mocks.writeRestartSentinel,
  formatDoctorNonInteractiveHint: mocks.formatDoctorNonInteractiveHint,
}));
vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: mocks.scheduleGatewaySigusr1Restart,
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
  readGatewayCallOptions: mocks.readGatewayCallOptions,
  resolveGatewayTarget: mocks.resolveGatewayTarget,
}));

import { createGatewayTool } from "./gateway-tool.js";

async function execTool(
  tool: ReturnType<typeof createGatewayTool>,
  params: Record<string, unknown>,
) {
  return (tool as unknown as { execute: (id: string, args: unknown) => Promise<unknown> }).execute(
    "test-id",
    params,
  );
}

function getCallArg<T>(mockFn: { mock: { calls: unknown[] } }, callIdx: number, argIdx: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIdx]?.[argIdx] as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to build common test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePatchParams(overrides: Record<string, unknown> = {}) {
  return {
    action: "config.patch",
    raw: '{"key":"value"}',
    baseHash: "abc123",
    sessionKey: "agent:main:main",
    note: "test patch",
    ...overrides,
  };
}

function makeTool(
  opts: {
    agentSessionKey?: string;
    agentChannel?: string;
    agentTo?: string;
    agentThreadId?: string;
    agentAccountId?: string;
  } = {},
) {
  return createGatewayTool({
    agentSessionKey: "agent:main:main",
    agentChannel: "discord",
    agentTo: "123456789",
    ...opts,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Live delivery context for RPC actions (config.apply / config.patch / update.run)
// ─────────────────────────────────────────────────────────────────────────────

describe("createGatewayTool – RPC delivery context forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path: full live context forwarded ──────────────────────────────

  it("forwards liveDeliveryContext when agentChannel and agentTo are both present", async () => {
    await execTool(makeTool(), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toEqual({
      channel: "discord",
      to: "123456789",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("includes agentAccountId in forwarded context when provided", async () => {
    await execTool(makeTool({ agentAccountId: "acct-99" }), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect((p?.deliveryContext as Record<string, unknown>)?.accountId).toBe("acct-99");
  });

  it("includes agentThreadId in forwarded context when provided", async () => {
    await execTool(
      makeTool({ agentChannel: "slack", agentTo: "C012AB3CD", agentThreadId: "1234567890.123" }),
      makePatchParams({ sessionKey: "agent:main:main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect((p?.deliveryContext as Record<string, unknown>)?.threadId).toBe("1234567890.123");
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("slack");
  });

  it("forwards live context for config.apply as well as config.patch", async () => {
    await execTool(makeTool(), {
      action: "config.apply",
      raw: '{"key":"value"}',
      baseHash: "abc123",
      sessionKey: "agent:main:main",
    });

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("discord");
  });

  it("forwards live context for update.run", async () => {
    await execTool(makeTool(), {
      action: "update.run",
      sessionKey: "agent:main:main",
    });

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("discord");
  });

  // ── Partial live context — must be suppressed ────────────────────────────

  it("suppresses deliveryContext when agentTo is missing", async () => {
    await execTool(makeTool({ agentTo: undefined }), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("suppresses deliveryContext when agentChannel is missing", async () => {
    await execTool(makeTool({ agentChannel: undefined }), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("suppresses deliveryContext when agentChannel is an empty string", async () => {
    await execTool(makeTool({ agentChannel: "" }), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("falls back to server extractDeliveryInfo when live context is suppressed", async () => {
    // Confirm the RPC call still goes through — server side will use extractDeliveryInfo
    await execTool(makeTool({ agentTo: undefined }), makePatchParams());

    expect(mocks.callGatewayTool).toHaveBeenCalled();
    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  // ── Stale heartbeat override prevention ─────────────────────────────────

  it("overrides stale heartbeat deliveryContext from extractDeliveryInfo with live context", async () => {
    // extractDeliveryInfo returning heartbeat sink — must not win over live context
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "webchat", to: "heartbeat", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool(), makePatchParams());

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("discord");
    expect((p?.deliveryContext as Record<string, unknown>)?.to).toBe("123456789");
  });

  // ── Session key targeting: same-session ─────────────────────────────────

  it("forwards live context when sessionKey matches own session key exactly", async () => {
    await execTool(
      makeTool({ agentSessionKey: "agent:main:main" }),
      makePatchParams({ sessionKey: "agent:main:main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
  });

  it("forwards live context when 'main' alias resolves to own default-agent session", async () => {
    // agentSessionKey is "agent:main:main"; sessionKey "main" should canonicalize to the same
    await execTool(
      makeTool({ agentSessionKey: "agent:main:main" }),
      makePatchParams({ sessionKey: "main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("discord");
  });

  it("forwards live context when sessionKey is omitted (defaults to own session)", async () => {
    await execTool(makeTool(), makePatchParams({ sessionKey: undefined }));

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
  });

  // ── Session key targeting: cross-session / cross-agent ───────────────────

  it("suppresses deliveryContext when sessionKey targets a different session", async () => {
    await execTool(
      makeTool({ agentSessionKey: "agent:main:main" }),
      makePatchParams({ sessionKey: "agent:other-claw:main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("suppresses deliveryContext when non-default agent passes sessionKey='main' (cross-agent alias)", async () => {
    // "main" resolves to "agent:main:main" (default), not "agent:shopping-claw:main"
    await execTool(
      makeTool({ agentSessionKey: "agent:shopping-claw:main" }),
      makePatchParams({ sessionKey: "main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  // ── Remote gateway targeting ─────────────────────────────────────────────

  it("suppresses deliveryContext when resolveGatewayTarget returns 'remote' (explicit URL)", async () => {
    mocks.readGatewayCallOptions.mockReturnValueOnce({ gatewayUrl: "wss://remote.example.com" });
    mocks.resolveGatewayTarget.mockReturnValueOnce("remote");

    await execTool(
      makeTool(),
      makePatchParams({ gatewayUrl: "wss://remote.example.com", sessionKey: "agent:main:main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("suppresses deliveryContext when resolveGatewayTarget returns 'remote' (config gateway.mode=remote)", async () => {
    mocks.readGatewayCallOptions.mockReturnValueOnce({});
    mocks.resolveGatewayTarget.mockReturnValueOnce("remote");

    await execTool(makeTool(), makePatchParams({ sessionKey: "agent:main:main" }));

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeUndefined();
  });

  it("forwards deliveryContext when resolveGatewayTarget returns 'local' (loopback URL)", async () => {
    mocks.readGatewayCallOptions.mockReturnValueOnce({ gatewayUrl: "ws://127.0.0.1:18789" });
    mocks.resolveGatewayTarget.mockReturnValueOnce("local");

    await execTool(
      makeTool(),
      makePatchParams({ gatewayUrl: "ws://127.0.0.1:18789", sessionKey: "agent:main:main" }),
    );

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
    expect((p?.deliveryContext as Record<string, unknown>)?.channel).toBe("discord");
  });

  it("forwards deliveryContext when resolveGatewayTarget returns undefined (default local)", async () => {
    mocks.resolveGatewayTarget.mockReturnValueOnce(undefined);

    await execTool(makeTool(), makePatchParams({ sessionKey: "agent:main:main" }));

    const p = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(p?.deliveryContext).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Restart sentinel context (local restart action)
// ─────────────────────────────────────────────────────────────────────────────

describe("createGatewayTool – restart sentinel delivery context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses live context when both agentChannel and agentTo are present", async () => {
    await execTool(makeTool(), { action: "restart" });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("discord");
    expect(p?.deliveryContext?.to).toBe("123456789");
  });

  it("falls back to extractDeliveryInfo when agentTo is missing", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "telegram", to: "+19995550001", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool({ agentTo: undefined }), { action: "restart" });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("telegram");
    expect(p?.deliveryContext?.to).toBe("+19995550001");
  });

  it("falls back to extractDeliveryInfo when agentChannel is missing", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "whatsapp", to: "+10000000001", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool({ agentChannel: undefined }), { action: "restart" });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("whatsapp");
  });

  it("overrides stale heartbeat context from extractDeliveryInfo with live context", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "webchat", to: "heartbeat", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool(), { action: "restart" });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("discord");
    expect(p?.deliveryContext?.to).toBe("123456789");
  });

  it("includes threadId in sentinel when agentThreadId is provided (same session)", async () => {
    await execTool(makeTool({ agentThreadId: "ts.123456" }), { action: "restart" });

    const p = getCallArg<{ threadId?: string }>(mocks.writeRestartSentinel, 0, 0);
    expect(p?.threadId).toBe("ts.123456");
  });

  it("uses extractDeliveryInfo threadId when targeting a different session", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "telegram", to: "+19995550001", accountId: undefined },
      threadId: "extracted-thread",
    });

    await execTool(makeTool({ agentThreadId: "local-thread" }), {
      action: "restart",
      sessionKey: "agent:other-claw:main",
    });

    const p = getCallArg<{ threadId?: string }>(mocks.writeRestartSentinel, 0, 0);
    expect(p?.threadId).toBe("extracted-thread");
  });

  it("suppresses live context and uses extractDeliveryInfo when sessionKey targets another session", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "signal", to: "+15550001", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool(), { action: "restart", sessionKey: "agent:other-agent:main" });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("signal");
    expect(p?.deliveryContext?.to).toBe("+15550001");
  });

  it("suppresses live context when non-default agent targets sessionKey='main' (cross-agent alias)", async () => {
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "telegram", to: "+19995550001", accountId: undefined },
      threadId: undefined,
    });

    await execTool(makeTool({ agentSessionKey: "agent:shopping-claw:main" }), {
      action: "restart",
      sessionKey: "main", // resolves to "agent:main:main" — different agent
    });

    const p = getCallArg<{ deliveryContext?: Record<string, unknown> }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(p?.deliveryContext?.channel).toBe("telegram");
    expect(p?.deliveryContext?.to).toBe("+19995550001");
  });

  it("sets status=ok and kind=restart on the sentinel payload", async () => {
    await execTool(makeTool(), { action: "restart" });

    const p = getCallArg<{ kind?: string; status?: string }>(mocks.writeRestartSentinel, 0, 0);
    expect(p?.kind).toBe("restart");
    expect(p?.status).toBe("ok");
  });

  it("includes sessionKey in sentinel payload", async () => {
    await execTool(makeTool({ agentSessionKey: "agent:main:main" }), {
      action: "restart",
    });

    const p = getCallArg<{ sessionKey?: string }>(mocks.writeRestartSentinel, 0, 0);
    expect(p?.sessionKey).toBe("agent:main:main");
  });
});
