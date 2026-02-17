import type { Client } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
  resolveDiscordThreadHistory,
} from "./threading.js";

describe("resolveDiscordAutoThreadContext", () => {
  it("returns null when no createdThreadId", () => {
    expect(
      resolveDiscordAutoThreadContext({
        agentId: "agent",
        channel: "discord",
        messageChannelId: "parent",
        createdThreadId: undefined,
      }),
    ).toBeNull();
  });

  it("re-keys session context to the created thread", () => {
    const context = resolveDiscordAutoThreadContext({
      agentId: "agent",
      channel: "discord",
      messageChannelId: "parent",
      createdThreadId: "thread",
    });
    expect(context).not.toBeNull();
    expect(context?.To).toBe("channel:thread");
    expect(context?.From).toBe("discord:channel:thread");
    expect(context?.OriginatingTo).toBe("channel:thread");
    expect(context?.SessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "thread" },
      }),
    );
    expect(context?.ParentSessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "parent" },
      }),
    );
  });
});

describe("resolveDiscordReplyDeliveryPlan", () => {
  it("uses reply references when posting to the original target", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: null,
      createdThreadId: null,
    });
    expect(plan.deliverTarget).toBe("channel:parent");
    expect(plan.replyTarget).toBe("channel:parent");
    expect(plan.replyReference.use()).toBe("m1");
  });

  it("disables reply references when autoThread creates a new thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: null,
      createdThreadId: "thread",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBeUndefined();
  });

  it("respects replyToMode off even inside a thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "off",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    expect(plan.replyReference.use()).toBeUndefined();
  });

  it("uses existingId when inside a thread with replyToMode all", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    // "all" returns the reference on every call.
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.replyReference.use()).toBe("m1");
  });

  it("uses existingId only on first call with replyToMode first inside a thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "first",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    // "first" returns the reference only once.
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.replyReference.use()).toBeUndefined();
  });
});

describe("maybeCreateDiscordAutoThread", () => {
  it("returns existing thread ID when creation fails due to race condition", async () => {
    // First call succeeds (simulating another agent creating the thread)
    const client = {
      rest: {
        post: async () => {
          throw new Error("A thread has already been created on this message");
        },
        get: async () => {
          // Return message with existing thread (simulating race condition resolution)
          return { thread: { id: "existing-thread" } };
        },
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as import("./allow-list.js").DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
    });

    expect(result).toBe("existing-thread");
  });

  it("returns undefined when creation fails and no existing thread found", async () => {
    const client = {
      rest: {
        post: async () => {
          throw new Error("Some other error");
        },
        get: async () => {
          // Message has no thread
          return { thread: null };
        },
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as import("./allow-list.js").DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveDiscordThreadHistory", () => {
  it("returns empty array when limit is 0", async () => {
    const client = { rest: { get: async () => [] } } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 0,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array on API error", async () => {
    const client = {
      rest: {
        get: async () => {
          throw new Error("Discord API error");
        },
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result).toEqual([]);
  });

  it("fetches messages with before param when currentMessageId is provided", async () => {
    let capturedParams: Record<string, unknown> = {};
    const client = {
      rest: {
        get: async (_route: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return [];
        },
      },
    } as unknown as Client;
    await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      currentMessageId: "msg123",
      limit: 10,
    });
    expect(capturedParams.before).toBe("msg123");
    expect(capturedParams.limit).toBe(10);
  });

  it("returns messages in chronological order (reversed from Discord API)", async () => {
    // Discord returns newest-first: [msg3, msg2, msg1]
    // We should return chronological: [msg1, msg2, msg3]
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg3",
            content: "third",
            author: { id: "u1", username: "alice" },
            timestamp: "2024-01-01T03:00:00Z",
          },
          {
            id: "msg2",
            content: "second",
            author: { id: "u1", username: "alice" },
            timestamp: "2024-01-01T02:00:00Z",
          },
          {
            id: "msg1",
            content: "first",
            author: { id: "u1", username: "alice" },
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result).toHaveLength(3);
    expect(result[0].messageId).toBe("msg1");
    expect(result[1].messageId).toBe("msg2");
    expect(result[2].messageId).toBe("msg3");
  });

  it("filters out messages with empty content", async () => {
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg2",
            content: "hello",
            author: { id: "u1", username: "alice" },
            timestamp: "2024-01-01T02:00:00Z",
          },
          {
            id: "msg1",
            content: "   ",
            author: { id: "u1", username: "alice" },
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello");
  });

  it("marks bot messages (author.bot=true) as isBot=true", async () => {
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg1",
            content: "bot reply",
            author: { id: "bot1", username: "MyBot", bot: true },
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result[0].isBot).toBe(true);
  });

  it("marks webhook messages (webhook_id set) as isBot=true", async () => {
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg1",
            content: "webhook msg",
            author: { id: "u1", username: "webhook" },
            webhook_id: "wh1",
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result[0].isBot).toBe(true);
  });

  it("marks application messages (application_id set) as isBot=true", async () => {
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg1",
            content: "app msg",
            author: { id: "app1", username: "App" },
            application_id: "app1",
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result[0].isBot).toBe(true);
  });

  it("caps fetch limit at 100 (Discord API maximum)", async () => {
    let capturedLimit: unknown;
    const client = {
      rest: {
        get: async (_route: string, params: Record<string, unknown>) => {
          capturedLimit = params.limit;
          return [];
        },
      },
    } as unknown as Client;
    await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 500,
    });
    expect(capturedLimit).toBe(100);
  });

  it("marks regular user messages as isBot=false", async () => {
    const client = {
      rest: {
        get: async () => [
          {
            id: "msg1",
            content: "hello",
            author: { id: "u1", username: "alice", bot: false },
            timestamp: "2024-01-01T01:00:00Z",
          },
        ],
      },
    } as unknown as Client;
    const result = await resolveDiscordThreadHistory({
      threadChannelId: "thread1",
      client,
      limit: 20,
    });
    expect(result[0].isBot).toBe(false);
    expect(result[0].userId).toBe("u1");
    expect(result[0].username).toBe("alice");
  });
});

describe("resolveDiscordAutoThreadReplyPlan", () => {
  it("switches delivery + session context to the created thread", async () => {
    const client = {
      rest: { post: async () => ({ id: "thread" }) },
    } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as import("./allow-list.js").DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBeUndefined();
    expect(plan.autoThreadContext?.SessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "thread" },
      }),
    );
  });

  it("routes replies to an existing thread channel", async () => {
    const client = { rest: { post: async () => ({ id: "thread" }) } } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as import("./allow-list.js").DiscordChannelConfigResolved,
      threadChannel: { id: "thread" },
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.autoThreadContext).toBeNull();
  });

  it("does nothing when autoThread is disabled", async () => {
    const client = { rest: { post: async () => ({ id: "thread" }) } } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: false,
      } as unknown as import("./allow-list.js").DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:parent");
    expect(plan.autoThreadContext).toBeNull();
  });
});
