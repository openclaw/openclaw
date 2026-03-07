import { describe, expect, it, vi } from "vitest";

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

describe("createGatewayTool – live delivery context guard", () => {
  it("does not forward liveDeliveryContextForRpc when agentTo is missing", async () => {
    mocks.callGatewayTool.mockClear();
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentTo: undefined, // intentionally missing
    });

    await execTool(tool, {
      action: "config.patch",
      raw: '{"key":"value"}',
      baseHash: "abc123",
      sessionKey: "agent:main:main",
      note: "test patch",
    });

    const forwardedParams = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    // deliveryContext should be undefined — falling back to server-side extractDeliveryInfo
    expect(forwardedParams?.deliveryContext).toBeUndefined();
  });

  it("forwards liveDeliveryContextForRpc when both agentChannel and agentTo are present", async () => {
    mocks.callGatewayTool.mockClear();
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentTo: "123456789",
    });

    await execTool(tool, {
      action: "config.patch",
      raw: '{"key":"value"}',
      baseHash: "abc123",
      sessionKey: "agent:main:main",
      note: "test patch",
    });

    const forwardedParams = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(forwardedParams?.deliveryContext).toEqual({
      channel: "discord",
      to: "123456789",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("includes threadId in liveDeliveryContextForRpc when agentThreadId is present", async () => {
    mocks.callGatewayTool.mockClear();
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "slack",
      agentTo: "C012AB3CD",
      agentThreadId: "1234567890.123456",
    });

    await execTool(tool, {
      action: "config.patch",
      raw: '{"key":"value"}',
      baseHash: "abc123",
      sessionKey: "agent:main:main",
      note: "test patch",
    });

    const forwardedParams = getCallArg<Record<string, unknown>>(mocks.callGatewayTool, 0, 2);
    expect(forwardedParams?.deliveryContext).toEqual({
      channel: "slack",
      to: "C012AB3CD",
      accountId: undefined,
      threadId: "1234567890.123456",
    });
  });

  it("does not forward live restart context when agentTo is missing", async () => {
    mocks.writeRestartSentinel.mockClear();
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "telegram", to: "+19995550001", accountId: undefined },
      threadId: undefined,
    });

    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentTo: undefined, // intentionally missing
    });

    await execTool(tool, { action: "restart" });

    const sentinelPayload = getCallArg<{ deliveryContext?: { channel?: string; to?: string } }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    // Should fall back to extractDeliveryInfo() result, not the incomplete live context
    expect(sentinelPayload?.deliveryContext?.channel).toBe("telegram");
    expect(sentinelPayload?.deliveryContext?.to).toBe("+19995550001");
  });

  it("uses live restart context when both agentChannel and agentTo are present", async () => {
    mocks.writeRestartSentinel.mockClear();

    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentTo: "123456789",
    });

    await execTool(tool, { action: "restart" });

    const sentinelPayload = getCallArg<{ deliveryContext?: { channel?: string; to?: string } }>(
      mocks.writeRestartSentinel,
      0,
      0,
    );
    expect(sentinelPayload?.deliveryContext?.channel).toBe("discord");
    expect(sentinelPayload?.deliveryContext?.to).toBe("123456789");
  });
});
