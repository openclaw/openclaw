/** Verifies hook callbacks receive agent context and scoped plugin metadata. */
import { describe, expect, it } from "vitest";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "./hook-agent-context.js";

describe("buildAgentHookContextChannelFields", () => {
  it("keeps provider and conversation id separate", () => {
    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:discord:channel:c1",
        messageChannel: "discord",
        messageProvider: "discord",
        agentAccountId: "work",
        senderId: "user-123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "work",
      messageProvider: "discord",
      channelId: "c1",
      chatId: "c1",
      senderId: "user-123",
    });
  });

  it("uses the provider as channel when message channel is a target id", () => {
    expect(
      buildAgentHookContextChannelFields({
        messageChannel: "channel:1472750640760623226",
        messageProvider: "discord",
      }),
    ).toEqual({
      channel: "discord",
      messageProvider: "discord",
      channelId: "1472750640760623226",
      chatId: "1472750640760623226",
      senderId: undefined,
    });
  });
});

describe("buildAgentHookContextIdentityFields", () => {
  it("mirrors flat sender and chat ids into channel-owned context", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({
      senderId: "open-id-1",
      chatId: "chat-1",
      channelContext: {
        sender: { id: "open-id-1" },
        chat: { id: "chat-1" },
      },
    });
  });

  it("preserves plugin-augmented channel fields while keeping id compatible", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        channelContext: {
          sender: { id: "stale-id", userId: "user-1" } as { id?: string; userId: string },
        },
      }),
    ).toEqual({
      senderId: "open-id-1",
      channelContext: {
        sender: { id: "open-id-1", userId: "user-1" },
      },
    });
  });

  it("omits identity fields for system-originated triggers", () => {
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "cron",
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({});
  });

  it.each([true, false, undefined])(
    "preserves resolved ownership %s without inventing it",
    (owner) => {
      const context = buildAgentHookContextIdentityFields({
        trigger: "user",
        senderId: "sender-1",
        causalMessageId: " message-1 ",
        senderIsOwner: owner,
      });
      expect(context.messageId).toBe("message-1");
      expect(context.senderIsOwner).toBe(owner);
      expect(Object.hasOwn(context, "senderIsOwner")).toBe(owner !== undefined);
    },
  );

  it("does not advertise ownership without a resolved sender", () => {
    const context = buildAgentHookContextIdentityFields({
      trigger: "user",
      causalMessageId: "message-1",
      senderIsOwner: true,
    });
    expect(context.messageId).toBe("message-1");
    expect(context).not.toHaveProperty("senderIsOwner");
  });

  it.each([
    { trigger: "cron" },
    { trigger: "heartbeat" },
    { trigger: "overflow" },
    { trigger: undefined },
    { trigger: "user", inputProvenance: { kind: "internal_system" as const } },
    { trigger: "user", inputProvenance: { kind: "inter_session" as const } },
  ])("withholds causal/owner metadata on non-external turns (%j)", (origin) => {
    const context = buildAgentHookContextIdentityFields({
      ...origin,
      senderId: "sender-1",
      causalMessageId: "technical-id",
      senderIsOwner: true,
    });
    expect(context).not.toHaveProperty("messageId");
    expect(context).not.toHaveProperty("senderIsOwner");
  });

  it("omits a blank causal id", () => {
    expect(
      buildAgentHookContextIdentityFields({ trigger: "user", causalMessageId: " " }),
    ).not.toHaveProperty("messageId");
  });
});
