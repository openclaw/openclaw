import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import {
  isAcpCommandDiscordChannel,
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
  resolveAcpCommandParentConversationId,
} from "./context.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function registerFeishuBindingAdapterForTest(accountId: string) {
  const bindings: SessionBindingRecord[] = [];
  registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: { placements: ["current"] },
    bind: async (input) => {
      const record: SessionBindingRecord = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: Date.now(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

describe("commands-acp context", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("resolves channel/account/thread context from originating fields", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:parent-1",
      AccountId: "work",
      MessageThreadId: "thread-42",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "discord",
      accountId: "work",
      threadId: "thread-42",
      conversationId: "thread-42",
      parentConversationId: "parent-1",
    });
    expect(isAcpCommandDiscordChannel(params)).toBe(true);
  });

  it("resolves discord thread parent from ParentSessionKey when targets point at the thread", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:thread-42",
      AccountId: "work",
      MessageThreadId: "thread-42",
      ParentSessionKey: "agent:codex:discord:channel:parent-9",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "discord",
      accountId: "work",
      threadId: "thread-42",
      conversationId: "thread-42",
      parentConversationId: "parent-9",
    });
  });

  it("resolves discord thread parent from native context when ParentSessionKey is absent", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:thread-42",
      AccountId: "work",
      MessageThreadId: "thread-42",
      ThreadParentId: "parent-11",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "discord",
      accountId: "work",
      threadId: "thread-42",
      conversationId: "thread-42",
      parentConversationId: "parent-11",
    });
  });

  it("falls back to default account and target-derived conversation id", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      To: "<#123456789>",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "slack",
      accountId: "default",
      threadId: undefined,
      conversationId: "123456789",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("123456789");
    expect(isAcpCommandDiscordChannel(params)).toBe(false);
  });

  it("builds canonical telegram topic conversation ids from originating chat + thread", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      MessageThreadId: "42",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "telegram",
      accountId: "default",
      threadId: "42",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("-1001234567890:topic:42");
  });

  it("resolves Telegram DM conversation ids from telegram targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123456789",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "telegram",
      accountId: "default",
      threadId: undefined,
      conversationId: "123456789",
      parentConversationId: "123456789",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("123456789");
  });

  it("resolves Matrix thread context from the current room and thread root", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "matrix",
      Surface: "matrix",
      OriginatingChannel: "matrix",
      OriginatingTo: "room:!room:example.org",
      AccountId: "work",
      MessageThreadId: "$thread-root",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "matrix",
      accountId: "work",
      threadId: "$thread-root",
      conversationId: "$thread-root",
      parentConversationId: "!room:example.org",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("$thread-root");
    expect(resolveAcpCommandParentConversationId(params)).toBe("!room:example.org");
  });

  it("builds Feishu topic conversation ids from chat target + root message id", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      MessageThreadId: "om_topic_root",
      SenderId: "ou_topic_user",
      AccountId: "work",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: "om_topic_root",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("builds sender-scoped Feishu topic conversation ids when current session is sender-scoped", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      MessageThreadId: "om_topic_root",
      SenderId: "ou_topic_user",
      AccountId: "work",
      SessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
    });
    params.sessionKey =
      "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: "om_topic_root",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
    });
    expect(resolveAcpCommandConversationId(params)).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
    );
  });

  it("preserves sender-scoped Feishu topic ids after ACP route takeover via ParentSessionKey", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      MessageThreadId: "om_topic_root",
      SenderId: "ou_topic_user",
      AccountId: "work",
      ParentSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
    });
    params.sessionKey = "agent:codex:acp:binding:feishu:work:abc123";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: "om_topic_root",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
    });
  });

  it("preserves sender-scoped Feishu topic ids after ACP takeover from the live binding record", async () => {
    registerFeishuBindingAdapterForTest("work");
    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:work:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "work",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
        parentConversationId: "oc_group_chat",
      },
      placement: "current",
      metadata: {
        agentId: "codex",
      },
    });

    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      MessageThreadId: "om_topic_root",
      SenderId: "ou_topic_user",
      AccountId: "work",
    });
    params.sessionKey = "agent:codex:acp:binding:feishu:work:abc123";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: "om_topic_root",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
    });
  });

  it("resolves Feishu DM conversation ids from user targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "user:ou_sender_1",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "default",
      threadId: undefined,
      conversationId: "ou_sender_1",
      parentConversationId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("ou_sender_1");
  });

  it("resolves Feishu DM conversation ids from user_id fallback targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "user:user_123",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "default",
      threadId: undefined,
      conversationId: "user_123",
      parentConversationId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("user_123");
  });

  it("does not infer a Feishu DM parent conversation id during fallback binding lookup", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "user:ou_sender_1",
      AccountId: "work",
    });

    expect(resolveAcpCommandParentConversationId(params)).toBeUndefined();
    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: undefined,
      conversationId: "ou_sender_1",
      parentConversationId: undefined,
    });
  });
});
