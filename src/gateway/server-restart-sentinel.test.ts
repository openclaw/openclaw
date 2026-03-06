import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  consumeRestartSentinel: vi.fn(async () => ({
    payload: {
      sessionKey: "agent:main:main",
      continuation: {
        kind: "agent-turn",
        prompt: "continue testing",
      },
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
  deliverOutboundPayloads: vi.fn(async () => []),
  enqueueSystemEvent: vi.fn(),
  agentCommandFromIngress: vi.fn(async () => ({ payloads: [], meta: {} })),
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

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../commands/agent.js", () => ({
  agentCommandFromIngress: mocks.agentCommandFromIngress,
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

describe("scheduleRestartSentinelWake", () => {
  it("forwards session context to outbound delivery and starts restart continuation", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
      }),
    );
    expect(mocks.agentCommandFromIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "continue testing",
        sessionKey: "agent:main:main",
        channel: "whatsapp",
        to: "+15550002",
        deliver: true,
        messageChannel: "whatsapp",
        bestEffortDeliver: true,
        senderIsOwner: true,
        inputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "gateway.restart.continuation",
        },
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
