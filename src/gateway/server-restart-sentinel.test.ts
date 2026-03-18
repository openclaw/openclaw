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
  deliverOutboundPayloads: vi.fn(async () => []),
  enqueueSystemEvent: vi.fn(),
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

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeRestartSentinel.mockResolvedValue({
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
    },
  });
  mocks.parseSessionThreadInfo.mockReturnValue({ baseSessionKey: null, threadId: undefined });
  mocks.loadSessionEntry.mockReturnValue({ cfg: {}, entry: {} });
  mocks.resolveAnnounceTargetFromKey.mockReturnValue(null);
  mocks.deliveryContextFromSession.mockReturnValue(undefined);
  mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "+15550002" });
});

describe("scheduleRestartSentinelWake", () => {
  it("forwards session context to outbound delivery", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
      }),
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("falls back to base session delivery only when the current session route is incomplete", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:slack:channel:C0AL50GP89M:thread:1773827207.576549",
        deliveryContext: {
          channel: "slack",
        },
      },
    });
    mocks.parseSessionThreadInfo.mockReturnValueOnce({
      baseSessionKey: "agent:main:slack:channel:C0ALZAZ6ZBK",
      threadId: "1773827207.576549",
    });
    mocks.loadSessionEntry
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          deliveryContext: {
            channel: "slack",
          },
        },
      })
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          deliveryContext: {
            channel: "slack",
            to: "channel:C0AL50GP89M",
            accountId: "default",
          },
        },
      });
    mocks.deliveryContextFromSession
      .mockReturnValueOnce({ channel: "slack" })
      .mockReturnValueOnce({
        channel: "slack",
        to: "channel:C0AL50GP89M",
        accountId: "default",
      });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true as const, to: "channel:C0AL50GP89M" });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "channel:C0AL50GP89M",
      }),
    );
  });
});
