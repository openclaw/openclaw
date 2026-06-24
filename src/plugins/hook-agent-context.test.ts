/** Verifies hook callbacks receive agent context and scoped plugin metadata. */
import { describe, expect, it } from "vitest";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
  buildAgentHookContextOriginFields,
  resolveAgentHookChannelId,
} from "./hook-agent-context.js";

describe("resolveAgentHookChannelId", () => {
  it("derives the conversation id from channel session keys", () => {
    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:discord:channel:1472750640760623226",
        messageChannel: "discord",
        messageProvider: "discord",
        currentChannelId: "channel:1472750640760623226",
      }),
    ).toBe("1472750640760623226");
  });

  it("uses target metadata when the session key is not a channel conversation", () => {
    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:main",
        messageProvider: "telegram",
        currentChannelId: "telegram:-1003841603622",
      }),
    ).toBe("-1003841603622");
  });

  it("uses message channel prefixes when provider is a narrower route label", () => {
    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:main",
        messageChannel: "discord",
        messageProvider: "discord-voice",
        currentChannelId: "discord:voice-room",
      }),
    ).toBe("voice-room");
  });

  it("uses prefixed message targets before falling back to the provider", () => {
    expect(
      resolveAgentHookChannelId({
        messageChannel: "channel:1472750640760623226",
        messageProvider: "discord",
      }),
    ).toBe("1472750640760623226");
  });

  it("falls back to legacy channel/provider values when no conversation id is available", () => {
    expect(
      resolveAgentHookChannelId({
        messageChannel: "discord",
        messageProvider: "discord",
      }),
    ).toBe("discord");
  });
});

describe("buildAgentHookContextChannelFields", () => {
  it("keeps provider and conversation id separate", () => {
    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:discord:channel:c1",
        messageChannel: "discord",
        messageProvider: "discord",
        senderId: "user-123",
      }),
    ).toEqual({
      channel: "discord",
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
});

describe("buildAgentHookContextOriginFields", () => {
  it("infers a canonical channel while preserving native chat identity", () => {
    expect(
      buildAgentHookContextOriginFields({
        sessionKey: "agent:main:main",
        messageProvider: "discord-voice",
        currentChannelId: "discord:1472750640760623226",
        trigger: "user",
        channelContext: {
          sender: { id: "user-123" },
          chat: { id: "native-chat-1" },
        },
      }),
    ).toEqual({
      channel: "discord",
      messageProvider: "discord-voice",
      channelId: "1472750640760623226",
      chatId: "native-chat-1",
      senderId: "user-123",
      channelContext: {
        sender: { id: "user-123" },
        chat: { id: "native-chat-1" },
      },
    });
  });

  it("does not infer native chat identity from a routing target", () => {
    expect(
      buildAgentHookContextOriginFields({
        messageChannel: "telegram",
        messageProvider: "telegram",
        currentChannelId: "telegram:-100123:topic:7",
        trigger: "user",
      }),
    ).toEqual({
      channel: "telegram",
      messageProvider: "telegram",
      channelId: "-100123:topic:7",
    });
  });

  it("keeps routing fields but omits requester identity for system triggers", () => {
    expect(
      buildAgentHookContextOriginFields({
        messageChannel: "telegram",
        messageProvider: "telegram",
        currentChannelId: "telegram:-100123",
        trigger: "cron",
        senderId: "stale-user",
        chatId: "stale-chat",
        channelContext: { sender: { id: "stale-user" }, chat: { id: "stale-chat" } },
      }),
    ).toEqual({
      channel: "telegram",
      messageProvider: "telegram",
      channelId: "-100123",
    });
  });
});
