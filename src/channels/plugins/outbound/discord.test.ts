import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";

const hoisted = vi.hoisted(() => {
  const sendMessageDiscordMock = vi.fn();
  const sendPollDiscordMock = vi.fn();
  const sendWebhookMessageDiscordMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  return {
    sendMessageDiscordMock,
    sendPollDiscordMock,
    sendWebhookMessageDiscordMock,
    getThreadBindingManagerMock,
  };
});

vi.mock("../../../discord/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../discord/send.js")>();
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => hoisted.sendMessageDiscordMock(...args),
    sendPollDiscord: (...args: unknown[]) => hoisted.sendPollDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) =>
      hoisted.sendWebhookMessageDiscordMock(...args),
  };
});

vi.mock("../../../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: (...args: unknown[]) => hoisted.getThreadBindingManagerMock(...args),
  };
});

const { discordOutbound } = await import("./discord.js");

describe("normalizeDiscordOutboundTarget", () => {
  it("normalizes bare numeric IDs to channel: prefix", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050")).toEqual({
      ok: true,
      to: "channel:1470130713209602050",
    });
  });

  it("passes through channel: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("channel:123")).toEqual({ ok: true, to: "channel:123" });
  });

  it("passes through user: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("user:123")).toEqual({ ok: true, to: "user:123" });
  });

  it("passes through channel name strings", () => {
    expect(normalizeDiscordOutboundTarget("general")).toEqual({ ok: true, to: "general" });
  });

  it("returns error for empty target", () => {
    expect(normalizeDiscordOutboundTarget("").ok).toBe(false);
  });

  it("returns error for undefined target", () => {
    expect(normalizeDiscordOutboundTarget(undefined).ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(normalizeDiscordOutboundTarget("  123  ")).toEqual({ ok: true, to: "channel:123" });
  });
});

describe("discordOutbound", () => {
  beforeEach(() => {
    hoisted.sendMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "ch-1",
    });
    hoisted.sendPollDiscordMock.mockReset().mockResolvedValue({
      messageId: "poll-1",
      channelId: "ch-1",
    });
    hoisted.sendWebhookMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-webhook-1",
      channelId: "thread-1",
    });
    hoisted.getThreadBindingManagerMock.mockReset().mockReturnValue(null);
  });

  it("routes text sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "hello",
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "hello",
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
  });

  it("uses webhook persona delivery for bound thread text replies", async () => {
    hoisted.getThreadBindingManagerMock.mockReturnValue({
      getByThreadId: () => ({
        accountId: "default",
        channelId: "parent-1",
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        label: "codex-thread",
        webhookId: "wh-1",
        webhookToken: "tok-1",
        boundBy: "system",
        boundAt: Date.now(),
      }),
    });

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "hello from persona",
      accountId: "default",
      threadId: "thread-1",
      replyToId: "reply-1",
      identity: {
        name: "Codex",
        avatarUrl: "https://example.com/avatar.png",
      },
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "hello from persona",
      expect.objectContaining({
        webhookId: "wh-1",
        webhookToken: "tok-1",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "reply-1",
        username: "Codex",
        avatarUrl: "https://example.com/avatar.png",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-webhook-1",
      channelId: "thread-1",
    });
  });

  it("falls back to bot send for silent delivery on bound threads", async () => {
    hoisted.getThreadBindingManagerMock.mockReturnValue({
      getByThreadId: () => ({
        accountId: "default",
        channelId: "parent-1",
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
        boundBy: "system",
        boundAt: Date.now(),
      }),
    });

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "silent update",
      accountId: "default",
      threadId: "thread-1",
      silent: true,
    });

    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "silent update",
      expect.objectContaining({
        accountId: "default",
        silent: true,
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
  });

  it("falls back to bot send when webhook send fails", async () => {
    hoisted.getThreadBindingManagerMock.mockReturnValue({
      getByThreadId: () => ({
        accountId: "default",
        channelId: "parent-1",
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
        boundBy: "system",
        boundAt: Date.now(),
      }),
    });
    hoisted.sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "fallback",
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "fallback",
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
  });

  it("routes poll sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendPoll?.({
      cfg: {},
      to: "channel:parent-1",
      poll: {
        question: "Best snack?",
        options: ["banana", "apple"],
      },
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendPollDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      {
        question: "Best snack?",
        options: ["banana", "apple"],
      },
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(result).toEqual({
      messageId: "poll-1",
      channelId: "ch-1",
    });
  });
});
