import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildTelegramMessageContext } from "./bot-message-context.js";

// Mock recordInboundSession to capture updateLastRoute parameter
const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: 1234, type: "private" },
          date: 1700000000,
          text: "hello",
          message_thread_id: 42, // DM Topic ID
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

    // Check that updateLastRoute includes threadId
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as {
      updateLastRoute?: { threadId?: string };
    };
    expect(callArgs?.updateLastRoute).toBeDefined();
    expect(callArgs?.updateLastRoute?.threadId).toBe("42");
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: 1234, type: "private" },
          date: 1700000000,
          text: "hello",
          // No message_thread_id
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

    // Check that updateLastRoute does NOT include threadId
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as {
      updateLastRoute?: { threadId?: string };
    };
    expect(callArgs?.updateLastRoute).toBeDefined();
    expect(callArgs?.updateLastRoute?.threadId).toBeUndefined();
  });

  it("does not set updateLastRoute for group messages", async () => {
    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
          date: 1700000000,
          text: "@bot hello",
          message_thread_id: 99,
          from: { id: 42, first_name: "Alice" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: { forceWasMentioned: true },
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
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute is undefined for groups
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as {
      updateLastRoute?: unknown;
    };
    expect(callArgs?.updateLastRoute).toBeUndefined();
  });
});
