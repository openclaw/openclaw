import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import {
  isAcpCommandDiscordChannel,
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
} from "./context.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("commands-acp context", () => {
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

  it("builds canonical Feishu thread conversation ids from chat + root message", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_thread_chat",
      AccountId: "work",
      NativeChannelId: "oc_thread_chat:thread:om_root_42",
      MessageThreadId: "om_root_42",
      ThreadParentId: "oc_thread_chat",
      RootMessageId: "om_root_42",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: "om_root_42",
      conversationId: "oc_thread_chat:thread:om_root_42",
      parentConversationId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("oc_thread_chat:thread:om_root_42");
  });

  it("uses NativeChannelId as the canonical Feishu conversation outside an active thread", () => {
    const params = buildCommandTestParams("/acp spawn codex --thread auto", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "user:ou_requester",
      AccountId: "work",
      NativeChannelId: "oc_dm_chat",
      MessageSid: "om_seed_42",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: undefined,
      conversationId: "oc_dm_chat",
      currentMessageId: "om_seed_42",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("oc_dm_chat");
  });

  it("synthesizes a Feishu thread conversation when root_id is absent", () => {
    const params = buildCommandTestParams("/acp spawn codex --thread here", baseCfg, {
      Provider: "feishu",
      Surface: "feishu",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_thread_chat",
      AccountId: "work",
      NativeChannelId: "oc_thread_chat",
      ThreadParentId: "oc_thread_chat",
      MessageSid: "om_followup_99",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "feishu",
      accountId: "work",
      threadId: undefined,
      conversationId: "oc_thread_chat:thread:om_followup_99",
      parentConversationId: undefined,
      currentMessageId: "om_followup_99",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("oc_thread_chat:thread:om_followup_99");
  });
});
