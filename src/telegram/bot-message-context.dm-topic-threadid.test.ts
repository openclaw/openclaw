import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

// Mock recordInboundSession to capture updateLastRoute parameter
const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

// Mock loadConfig so resolveAgentRoute picks up dmScope from tests
const loadConfigMock = vi.fn();
vi.mock("../config/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config/config.js")>();
  return { ...orig, loadConfig: () => loadConfigMock() };
});

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
    });
  }

  function getUpdateLastRoute(): unknown {
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as { updateLastRoute?: unknown };
    return callArgs?.updateLastRoute;
  }

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    loadConfigMock.mockReturnValue(baseConfig);
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute includes threadId
    const updateLastRoute = getUpdateLastRoute() as { threadId?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.threadId).toBe("42");
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute does NOT include threadId
    const updateLastRoute = getUpdateLastRoute() as { threadId?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.threadId).toBeUndefined();
  });

  it("does not set updateLastRoute for DM when dmScope isolates sessions (#13559)", async () => {
    const perChannelPeerConfig = {
      ...baseConfig,
      session: { dmScope: "per-channel-peer" },
    };
    loadConfigMock.mockReturnValue(perChannelPeerConfig);

    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: 1234, type: "private" },
          date: 1700000000,
          text: "hello",
          from: { id: 42, first_name: "Alice" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: {},
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: baseConfig,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // When dmScope isolates sessions, updateLastRoute should NOT overwrite mainSessionKey
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as {
      updateLastRoute?: unknown;
    };
    expect(callArgs?.updateLastRoute).toBeUndefined();
  });

  it("does not set updateLastRoute for group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute is undefined for groups
    expect(getUpdateLastRoute()).toBeUndefined();
  });
});
