import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContext } from "./bot-message-context.js";

// Mock the pairing module to capture pairing code creation
vi.mock("../pairing/pairing-store.js", () => ({
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "TEST1234", created: true }),
}));

describe("buildTelegramMessageContext pairing reply DM topic (#8820)", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  it("passes message_thread_id to pairing reply in DM topic", async () => {
    const sendMessageSpy = vi.fn().mockResolvedValue({ message_id: 1 });
    const sendChatActionSpy = vi.fn();

    // Simulate a DM message with topic (DM Topics feature, Bot API 9.3+)
    // from an unauthorized user with dmPolicy="pairing"
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
          sendChatAction: sendChatActionSpy,
          setMessageReaction: vi.fn(),
          sendMessage: sendMessageSpy,
        },
      } as never,
      cfg: baseConfig,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "pairing", // This triggers pairing reply for unauthorized users
      allowFrom: [], // Empty allowlist means user is not authorized
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

    // The context should be null because user is not authorized
    // but pairing reply should have been sent
    expect(ctx).toBeNull();

    // Check if sendMessage was called with message_thread_id
    expect(sendMessageSpy).toHaveBeenCalled();
    const lastCall = sendMessageSpy.mock.calls[sendMessageSpy.mock.calls.length - 1];
    const options = lastCall?.[2] as { message_thread_id?: number } | undefined;
    expect(options?.message_thread_id).toBe(42);
  });

  it("does not pass message_thread_id for regular DM pairing reply", async () => {
    const sendMessageSpy = vi.fn().mockResolvedValue({ message_id: 1 });
    const sendChatActionSpy = vi.fn();

    // Simulate a regular DM message (no topic)
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
          sendChatAction: sendChatActionSpy,
          setMessageReaction: vi.fn(),
          sendMessage: sendMessageSpy,
        },
      } as never,
      cfg: baseConfig,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "pairing",
      allowFrom: [], // Empty allowlist means user is not authorized
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

    // The context should be null because user is not authorized
    expect(ctx).toBeNull();

    // Check if sendMessage was called without message_thread_id
    expect(sendMessageSpy).toHaveBeenCalled();
    const lastCall = sendMessageSpy.mock.calls[sendMessageSpy.mock.calls.length - 1];
    const options = lastCall?.[2] as { message_thread_id?: number } | undefined;
    expect(options?.message_thread_id).toBeUndefined();
  });
});
