import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStorePath = "/state/agents/main/sessions/sessions.json";

const mocks = vi.hoisted(() => {
  const stores = new Map<string, Record<string, unknown>>();
  return {
    stores,
    resolveStateDir: vi.fn(() => "/state"),
    resolveAgentSessionDirs: vi.fn(async () => ["/state/agents/main/sessions"]),
    loadSessionStore: vi.fn((storePath: string) => {
      return stores.get(storePath) ?? {};
    }),
    updateSessionStore: vi.fn(
      async (storePath: string, updater: (store: Record<string, unknown>) => void) => {
        const current = stores.get(storePath) ?? {};
        updater(current);
        stores.set(storePath, current);
      },
    ),
    loadConfig: vi.fn(() => ({})),
    parseSessionThreadInfo: vi.fn(() => ({ baseSessionKey: null, threadId: undefined })),
    resolveAnnounceTargetFromKey: vi.fn(() => null),
    deliveryContextFromSession: vi.fn((entry: { deliveryContext?: Record<string, unknown> }) => {
      return entry.deliveryContext as
        | { channel?: string; to?: string; accountId?: string; threadId?: string }
        | undefined;
    }),
    mergeDeliveryContext: vi.fn(
      (
        a?: { channel?: string; to?: string; accountId?: string; threadId?: string },
        b?: { channel?: string; to?: string; accountId?: string; threadId?: string },
      ) => ({
        ...b,
        ...a,
      }),
    ),
    normalizeChannelId: vi.fn((channel: string) => channel),
    resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15550001" })),
    buildOutboundSessionContext: vi.fn(() => ({ key: "agent:main:main", agentId: "main" })),
    deliverOutboundPayloads: vi.fn(async () => []),
    enqueueSystemEvent: vi.fn(),
  };
});

vi.mock("../config/paths.js", () => ({
  resolveStateDir: mocks.resolveStateDir,
}));

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: mocks.resolveAgentSessionDirs,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
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

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

const { scheduleInterruptedRunsWake } = await import("./server-interrupted-runs.js");

describe("scheduleInterruptedRunsWake", () => {
  beforeEach(() => {
    mocks.stores.clear();
    mocks.resolveAgentSessionDirs.mockResolvedValue(["/state/agents/main/sessions"]);
    mocks.resolveAnnounceTargetFromKey.mockReturnValue(null);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "+15550001" });
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.updateSessionStore.mockClear();
  });

  it("delivers interruption message and clears in-flight markers", async () => {
    mocks.stores.set(mockStorePath, {
      "agent:main:main": {
        sessionId: "sess-1",
        updatedAt: 10,
        inFlightRunStartedAt: 20,
        inFlightRunSummary: "long    task   with extra spaces",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550001",
          accountId: "acct-1",
        },
      },
    });

    await scheduleInterruptedRunsWake();

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550001",
        payloads: [
          expect.objectContaining({
            text: expect.stringContaining("Gateway restarted during an in-flight task"),
          }),
        ],
      }),
    );

    const updated = (mocks.stores.get(mockStorePath)?.["agent:main:main"] ?? {}) as {
      abortedLastRun?: boolean;
      inFlightRunStartedAt?: number;
      inFlightRunSummary?: string;
      inFlightRunSessionId?: string;
    };
    expect(updated.abortedLastRun).toBe(true);
    expect(updated.inFlightRunStartedAt).toBeUndefined();
    expect(updated.inFlightRunSummary).toBeUndefined();
    expect(updated.inFlightRunSessionId).toBeUndefined();
  });

  it("falls back to system events when no delivery route is available", async () => {
    mocks.stores.set(mockStorePath, {
      "agent:main:main": {
        sessionId: "sess-2",
        updatedAt: 10,
        inFlightRunStartedAt: 20,
      },
    });

    await scheduleInterruptedRunsWake();

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Gateway restarted during an in-flight task"),
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });
});
