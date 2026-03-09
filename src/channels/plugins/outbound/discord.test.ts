import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";

const hoisted = vi.hoisted(() => {
  const sendMessageDiscordMock = vi.fn();
  const editMessageDiscordMock = vi.fn();
  const sendPollDiscordMock = vi.fn();
  const sendWebhookMessageDiscordMock = vi.fn();
  const archiveDiscordThreadMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  return {
    sendMessageDiscordMock,
    editMessageDiscordMock,
    sendPollDiscordMock,
    sendWebhookMessageDiscordMock,
    archiveDiscordThreadMock,
    getThreadBindingManagerMock,
  };
});

vi.mock("../../../discord/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../discord/send.js")>();
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => hoisted.sendMessageDiscordMock(...args),
    editMessageDiscord: (...args: unknown[]) => hoisted.editMessageDiscordMock(...args),
    sendPollDiscord: (...args: unknown[]) => hoisted.sendPollDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) =>
      hoisted.sendWebhookMessageDiscordMock(...args),
  };
});

vi.mock("../../../discord/monitor/thread-bindings.discord-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../discord/monitor/thread-bindings.discord-api.js")
    >();
  return {
    ...actual,
    archiveDiscordThread: (...args: unknown[]) => hoisted.archiveDiscordThreadMock(...args),
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

const DEFAULT_DISCORD_SEND_RESULT = {
  channel: "discord",
  messageId: "msg-1",
  channelId: "ch-1",
} as const;

function expectThreadBotSend(params: {
  text: string;
  result: unknown;
  options?: Record<string, unknown>;
}) {
  expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
    "channel:thread-1",
    params.text,
    expect.objectContaining({
      accountId: "default",
      ...params.options,
    }),
  );
  expect(params.result).toEqual(DEFAULT_DISCORD_SEND_RESULT);
}

function mockBoundThreadManager() {
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
}

describe("normalizeDiscordOutboundTarget", () => {
  it("normalizes bare numeric IDs to channel: prefix", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050")).toEqual({
      ok: true,
      to: "channel:1470130713209602050",
    });
  });

  it("passes through channel: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("channel:123")).toEqual({
      ok: true,
      to: "channel:123",
    });
  });

  it("passes through user: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("user:123")).toEqual({
      ok: true,
      to: "user:123",
    });
  });

  it("passes through channel name strings", () => {
    expect(normalizeDiscordOutboundTarget("general")).toEqual({
      ok: true,
      to: "general",
    });
  });

  it("returns error for empty target", () => {
    expect(normalizeDiscordOutboundTarget("").ok).toBe(false);
  });

  it("returns error for undefined target", () => {
    expect(normalizeDiscordOutboundTarget(undefined).ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(normalizeDiscordOutboundTarget("  123  ")).toEqual({
      ok: true,
      to: "channel:123",
    });
  });
});

describe("discordOutbound", () => {
  beforeEach(() => {
    hoisted.sendMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "msg-1",
      channelId: "ch-1",
    });
    hoisted.editMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "msg-1",
      channelId: "thread-1",
    });
    hoisted.sendPollDiscordMock.mockClear().mockResolvedValue({
      messageId: "poll-1",
      channelId: "ch-1",
    });
    hoisted.sendWebhookMessageDiscordMock.mockClear().mockResolvedValue({
      messageId: "msg-webhook-1",
      channelId: "thread-1",
    });
    hoisted.archiveDiscordThreadMock.mockClear().mockResolvedValue(undefined);
    hoisted.getThreadBindingManagerMock.mockClear().mockReturnValue(null);
  });

  it("routes text sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "hello",
      accountId: "default",
      threadId: "thread-1",
    });

    expectThreadBotSend({
      text: "hello",
      result,
    });
  });

  it("uses webhook persona delivery for bound thread text replies", async () => {
    mockBoundThreadManager();
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };

    const result = await discordOutbound.sendText?.({
      cfg,
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
    expect(
      (hoisted.sendWebhookMessageDiscordMock.mock.calls[0]?.[1] as { cfg?: unknown } | undefined)
        ?.cfg,
    ).toBe(cfg);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-webhook-1",
      channelId: "thread-1",
    });
  });

  it("falls back to bot send for silent delivery on bound threads", async () => {
    mockBoundThreadManager();

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "silent update",
      accountId: "default",
      threadId: "thread-1",
      silent: true,
    });

    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expectThreadBotSend({
      text: "silent update",
      result,
      options: { silent: true },
    });
  });

  it("falls back to bot send when webhook send fails", async () => {
    mockBoundThreadManager();
    hoisted.sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "fallback",
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expectThreadBotSend({
      text: "fallback",
      result,
    });
  });

  it("archives the current thread after sending archive-aware payloads", async () => {
    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:parent-1",
      text: "✅ ACP session closed and thread archived.",
      payload: {
        text: "✅ ACP session closed and thread archived.",
        channelData: {
          discord: {
            archiveCurrentThreadAfterReply: true,
            archiveFailureText: "⚠️ ACP session closed, but thread archive failed.",
          },
        },
      },
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "✅ ACP session closed and thread archived.",
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(hoisted.archiveDiscordThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        threadId: "thread-1",
      }),
    );
    expect(hoisted.editMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual(DEFAULT_DISCORD_SEND_RESULT);
  });

  it("honors sendDiscord overrides for archive-after-reply payloads", async () => {
    const sendDiscordOverride = vi.fn().mockResolvedValue({
      channel: "discord",
      messageId: "override-msg-1",
      channelId: "override-thread-1",
    });

    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:parent-1",
      text: "✅ ACP session closed and thread archived.",
      payload: {
        text: "✅ ACP session closed and thread archived.",
        channelData: {
          discord: {
            archiveCurrentThreadAfterReply: true,
            archiveFailureText: "⚠️ ACP session closed, but thread archive failed.",
          },
        },
      },
      accountId: "default",
      threadId: "thread-1",
      deps: {
        sendDiscord: sendDiscordOverride,
      },
    });

    expect(sendDiscordOverride).toHaveBeenCalledWith(
      "channel:thread-1",
      "✅ ACP session closed and thread archived.",
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(hoisted.archiveDiscordThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        threadId: "thread-1",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "override-msg-1",
      channelId: "override-thread-1",
    });
  });

  it("edits the reply to partial success text when thread archive fails", async () => {
    hoisted.archiveDiscordThreadMock.mockRejectedValueOnce(new Error("archive failed"));

    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:parent-1",
      text: "✅ ACP session closed and thread archived.",
      payload: {
        text: "✅ ACP session closed and thread archived.",
        channelData: {
          discord: {
            archiveCurrentThreadAfterReply: true,
            archiveFailureText: "⚠️ ACP session closed, but thread archive failed.",
          },
        },
      },
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.editMessageDiscordMock).toHaveBeenCalledWith(
      "thread-1",
      "msg-1",
      { content: "⚠️ ACP session closed, but thread archive failed." },
      expect.objectContaining({
        accountId: "default",
      }),
    );
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
