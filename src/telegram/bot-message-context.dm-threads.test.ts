import { describe, expect, it, vi } from "vitest";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";

describe("buildTelegramMessageContext dm thread sessions", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
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
      telegramCfg: baseConfig.channels.telegram as never,
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

  it("uses thread session key for dm topics", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 1234, type: "private" },
      date: 1700000000,
      text: "hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:42");
  });

  it("keeps legacy dm session key when no thread id", async () => {
    const ctx = await buildContext({
      message_id: 2,
      chat: { id: 1234, type: "private" },
      date: 1700000001,
      text: "hello",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});

describe("buildTelegramMessageContext group sessions without forum", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
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
      telegramCfg: baseConfig.channels.telegram as never,
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

  it("ignores message_thread_id for regular groups (not forums)", async () => {
    // When someone replies to a message in a non-forum group, Telegram sends
    // message_thread_id but this should NOT create a separate session
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42, // This is a reply thread, NOT a forum topic
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key should NOT include :topic:42
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890");
    // MessageThreadId should be undefined (not a forum)
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
  });

  it("keeps same session for regular group with and without message_thread_id", async () => {
    const ctxWithThread = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    const ctxWithoutThread = await buildContext({
      message_id: 2,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000001,
      text: "@bot world",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctxWithThread).not.toBeNull();
    expect(ctxWithoutThread).not.toBeNull();
    // Both messages should use the same session key
    expect(ctxWithThread?.ctxPayload?.SessionKey).toBe(ctxWithoutThread?.ctxPayload?.SessionKey);
  });

  it("uses topic session for forum groups with message_thread_id", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 99,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key SHOULD include :topic:99 for forums
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(99);
  });
});

describe("buildTelegramMessageContext dynamic agents", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: { dynamicAgents: "dm+group" } },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
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
      telegramCfg: baseConfig.channels.telegram as never,
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

  it("routes dm to per-user agent", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 1234, type: "private" },
      date: 1700000000,
      text: "hello",
      from: { id: 42, first_name: "Alice" },
    });

    const expectedAgentId = sanitizeAgentId("tgdm-default-42");
    const expectedSessionKey = buildAgentSessionKey({
      agentId: expectedAgentId,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "dm", id: "1234" },
      dmScope: baseConfig.session?.dmScope,
      identityLinks: baseConfig.session?.identityLinks,
    }).toLowerCase();
    expect(ctx).not.toBeNull();
    expect(ctx?.route?.agentId).toBe(expectedAgentId);
    expect(ctx?.ctxPayload?.SessionKey).toBe(expectedSessionKey);
  });

  it("routes group to per-group agent", async () => {
    const groupId = -1001234567890;
    const ctx = await buildContext({
      message_id: 2,
      chat: { id: groupId, type: "supergroup", title: "Test Group" },
      date: 1700000001,
      text: "@bot hello",
      from: { id: 42, first_name: "Alice" },
    });

    const expectedAgentId = sanitizeAgentId(`tggroup-default-${groupId}`);
    const expectedSessionKey = buildAgentSessionKey({
      agentId: expectedAgentId,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "group", id: buildTelegramGroupPeerId(groupId) },
      dmScope: baseConfig.session?.dmScope,
      identityLinks: baseConfig.session?.identityLinks,
    }).toLowerCase();
    expect(ctx).not.toBeNull();
    expect(ctx?.route?.agentId).toBe(expectedAgentId);
    expect(ctx?.ctxPayload?.SessionKey).toBe(expectedSessionKey);
  });

  it("routes forum group to per-group agent with topic session key", async () => {
    const groupId = -1001234567890;
    const threadId = 99;
    const ctx = await buildContext({
      message_id: 3,
      chat: { id: groupId, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000002,
      text: "@bot hello",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    });

    const expectedAgentId = sanitizeAgentId(`tggroup-default-${groupId}`);
    const expectedSessionKey = buildAgentSessionKey({
      agentId: expectedAgentId,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "group", id: buildTelegramGroupPeerId(groupId, threadId) },
      dmScope: baseConfig.session?.dmScope,
      identityLinks: baseConfig.session?.identityLinks,
    }).toLowerCase();
    expect(ctx).not.toBeNull();
    expect(ctx?.route?.agentId).toBe(expectedAgentId);
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(threadId);
    expect(ctx?.ctxPayload?.SessionKey).toBe(expectedSessionKey);
  });
});
