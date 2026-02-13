import type { Client } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
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
