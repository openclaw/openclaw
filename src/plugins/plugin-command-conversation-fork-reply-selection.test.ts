import { describe, expect, it } from "vitest";
import { conversationIdentityFromMsgContext } from "../config/sessions/conversation-identity.js";
import {
  resolvePluginForkReplyConversationRef,
  resolvePluginForkReplyToId,
} from "./plugin-command-conversation-fork-reply-selection.js";

describe("plugin fork reply origin", () => {
  const topic = {
    channel: "telegram",
    accountId: "default",
    conversationId: "-100123:topic:41",
    parentConversationId: "-100123",
  };

  it("derives the persisted Telegram source reference from authenticated route facts", () => {
    expect(
      resolvePluginForkReplyConversationRef({
        conversation: { ...topic, accountId: "sut", conversationId: "-5388079649" },
        chatType: "group",
      }),
    ).toBe("conv_782c2b7b332e9d6c5060e8420c84d0ce");
    const nativeTopic = conversationIdentityFromMsgContext({
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-100123:topic:41",
        AccountId: "default",
        ChatType: "group",
        ConversationRoutePeerId: "-100123:topic:41",
        MessageThreadId: 41,
        ThreadParentId: "-100123",
        From: "telegram:group:-100123:topic:41",
        To: "telegram:-100123:topic:41",
      },
    });
    expect(
      resolvePluginForkReplyConversationRef({
        conversation: topic,
        chatType: "group",
        messageThreadId: 41,
      }),
    ).toBe(nativeTopic?.conversationRef);
    expect(resolvePluginForkReplyConversationRef({ conversation: topic })).toBeUndefined();
  });

  it("treats Telegram's implicit topic-root reply as a tip fork", () => {
    expect(
      resolvePluginForkReplyToId({
        conversation: topic,
        messageThreadId: 41,
        replyToId: "41",
      }),
    ).toBeUndefined();
  });

  it("preserves an explicit reply in the same topic", () => {
    expect(
      resolvePluginForkReplyToId({
        conversation: topic,
        messageThreadId: 41,
        replyToId: "99",
      }),
    ).toBe("99");
  });

  it("does not suppress a non-topic or foreign-root reply", () => {
    expect(
      resolvePluginForkReplyToId({
        conversation: { ...topic, conversationId: "-100123" },
        messageThreadId: 41,
        replyToId: "41",
      }),
    ).toBe("41");
    expect(
      resolvePluginForkReplyToId({
        conversation: topic,
        messageThreadId: 42,
        replyToId: "42",
      }),
    ).toBe("42");
  });
});
