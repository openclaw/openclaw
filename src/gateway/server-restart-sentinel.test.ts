import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.js";

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

const delivery = (value: DeliveryContext) => value;

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
        session: { key: "agent:main:main", agentId: "main" },
      }),
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("prefers the parsed thread target over a stale base-session route", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:slack:channel:C0AL50GP89M:thread:1773827207.576549",
        deliveryContext: delivery({
          channel: "slack",
        }),
      },
    });
    mocks.parseSessionThreadInfo.mockReturnValueOnce({
      baseSessionKey: "agent:main:slack:channel:C0ALZAZ6ZBK",
      threadId: "1773827207.576549",
    });
    mocks.resolveAnnounceTargetFromKey.mockReturnValueOnce(
      delivery({
        channel: "slack",
        to: "channel:C0AL50GP89M",
        threadId: "1773827207.576549",
      }),
    );
    mocks.loadSessionEntry
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          deliveryContext: delivery({
            channel: "slack",
          }),
        },
      })
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          deliveryContext: delivery({
            channel: "slack",
            to: "channel:C0ALZAZ6ZBK",
            accountId: "default",
          }),
        },
      });
    mocks.deliveryContextFromSession
      .mockReturnValueOnce(delivery({ channel: "slack" }))
      .mockReturnValueOnce(
        delivery({
          channel: "slack",
          to: "channel:C0ALZAZ6ZBK",
          accountId: "default",
        }),
      );
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true as const,
      to: "channel:C0AL50GP89M",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "channel:C0AL50GP89M",
      }),
    );
  });

  it("preserves partial sentinel account hints while resolving the route from session data", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:slack:channel:C0AL50GP89M:thread:1773827207.576549",
        deliveryContext: delivery({
          channel: "slack",
          accountId: "acct-2",
        }),
      },
    });
    mocks.parseSessionThreadInfo.mockReturnValueOnce({
      baseSessionKey: null,
      threadId: "1773827207.576549",
    });
    mocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      entry: {
        deliveryContext: delivery({
          channel: "slack",
          to: "channel:C0AL50GP89M",
        }),
      },
    });
    mocks.deliveryContextFromSession.mockReturnValueOnce(
      delivery({
        channel: "slack",
        to: "channel:C0AL50GP89M",
      }),
    );
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true as const,
      to: "channel:C0AL50GP89M",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.loadSessionEntry).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "channel:C0AL50GP89M",
        accountId: "acct-2",
      }),
    );
  });

  it("falls back to a system event when baseSessionKey is null and the session route stays incomplete", async () => {
    mocks.consumeRestartSentinel.mockResolvedValueOnce({
      payload: {
        sessionKey: "agent:main:slack:channel:C0AL50GP89M:thread:1773827207.576549",
        deliveryContext: delivery({
          channel: "slack",
        }),
      },
    });
    mocks.parseSessionThreadInfo.mockReturnValueOnce({
      baseSessionKey: null,
      threadId: "1773827207.576549",
    });
    mocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      entry: {
        deliveryContext: delivery({
          channel: "slack",
        }),
      },
    });
    mocks.deliveryContextFromSession.mockReturnValueOnce(
      delivery({
        channel: "slack",
      }),
    );

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.loadSessionEntry).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:slack:channel:C0AL50GP89M:thread:1773827207.576549",
    });
  });
});
