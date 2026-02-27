import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleSlackAction } from "./slack-actions.js";

const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackEmojis = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackPins = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackReactions = vi.fn(async (..._args: unknown[]) => ({}));
const pinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const reactSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const readSlackMessages = vi.fn(async (..._args: unknown[]) => ({}));
const removeOwnSlackReactions = vi.fn(async (..._args: unknown[]) => ["thumbsup"]);
const removeSlackReaction = vi.fn(async (..._args: unknown[]) => ({}));
const sendSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const unpinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("../../slack/actions.js", () => ({
  deleteSlackMessage: (...args: Parameters<typeof deleteSlackMessage>) =>
    deleteSlackMessage(...args),
  editSlackMessage: (...args: Parameters<typeof editSlackMessage>) => editSlackMessage(...args),
  getSlackMemberInfo: (...args: Parameters<typeof getSlackMemberInfo>) =>
    getSlackMemberInfo(...args),
  listSlackEmojis: (...args: Parameters<typeof listSlackEmojis>) => listSlackEmojis(...args),
  listSlackPins: (...args: Parameters<typeof listSlackPins>) => listSlackPins(...args),
  listSlackReactions: (...args: Parameters<typeof listSlackReactions>) =>
    listSlackReactions(...args),
  pinSlackMessage: (...args: Parameters<typeof pinSlackMessage>) => pinSlackMessage(...args),
  reactSlackMessage: (...args: Parameters<typeof reactSlackMessage>) => reactSlackMessage(...args),
  readSlackMessages: (...args: Parameters<typeof readSlackMessages>) => readSlackMessages(...args),
  removeOwnSlackReactions: (...args: Parameters<typeof removeOwnSlackReactions>) =>
    removeOwnSlackReactions(...args),
  removeSlackReaction: (...args: Parameters<typeof removeSlackReaction>) =>
    removeSlackReaction(...args),
  sendSlackMessage: (...args: Parameters<typeof sendSlackMessage>) => sendSlackMessage(...args),
  unpinSlackMessage: (...args: Parameters<typeof unpinSlackMessage>) => unpinSlackMessage(...args),
}));

describe("handleSlackAction", () => {
  function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return {
      channels: {
        slack: {
          botToken: "tok",
          ...overrides,
        },
      },
    } as OpenClawConfig;
  }

  function createReplyToFirstContext(hasRepliedRef: { value: boolean }) {
    return {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first" as const,
      hasRepliedRef,
    };
  }

  function createReplyToFirstScenario() {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    return { cfg, context, hasRepliedRef };
  }

  function expectLastSlackSend(content: string, threadTs?: string) {
    expect(sendSlackMessage).toHaveBeenLastCalledWith("channel:C123", content, {
      mediaUrl: undefined,
      threadTs,
      blocks: undefined,
    });
  }

  async function sendSecondMessageAndExpectNoThread(params: {
    cfg: OpenClawConfig;
    context: ReturnType<typeof createReplyToFirstContext>;
  }) {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "Second" },
      params.cfg,
      params.context,
    );
    expectLastSlackSend("Second");
  }

  async function resolveReadToken(cfg: OpenClawConfig): Promise<string | undefined> {
    readSlackMessages.mockClear();
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });
    await handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg);
    const opts = readSlackMessages.mock.calls[0]?.[1] as { token?: string } | undefined;
    return opts?.token;
  }

  async function resolveSendToken(cfg: OpenClawConfig): Promise<string | undefined> {
    sendSlackMessage.mockClear();
    await handleSlackAction({ action: "sendMessage", to: "channel:C1", content: "Hello" }, cfg);
    const opts = sendSlackMessage.mock.calls[0]?.[2] as { token?: string } | undefined;
    return opts?.token;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { name: "raw channel id", channelId: "C1" },
    { name: "channel: prefixed id", channelId: "channel:C1" },
  ])("adds reactions for $name", async ({ channelId }) => {
    await handleSlackAction(
      {
        action: "react",
        channelId,
        messageId: "123.456",
        emoji: "✅",
      },
      slackConfig(),
    );
    expect(reactSlackMessage).toHaveBeenCalledWith("C1", "123.456", "✅");
  });

  it("removes reactions on empty emoji", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "",
      },
      slackConfig(),
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456");
  });

  it("removes reactions when remove flag set", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      slackConfig(),
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C1", "123.456", "✅");
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "",
          remove: true,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "✅",
        },
        slackConfig({ actions: { reactions: false } }),
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
  });

  it("passes threadTs to sendSlackMessage for thread replies", async () => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
      },
      slackConfig(),
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "Hello thread", {
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      blocks: undefined,
    });
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([
        { type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } },
      ]),
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "divider" }],
      expectedBlocks: [{ type: "divider" }],
    },
  ])("accepts $name and allows empty content", async ({ blocks, expectedBlocks }) => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        blocks,
      },
      slackConfig(),
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "", {
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: expectedBlocks,
    });
  });

  it.each([
    {
      name: "invalid blocks JSON",
      blocks: "{bad-json",
      expectedError: /blocks must be valid JSON/i,
    },
    { name: "empty blocks arrays", blocks: "[]", expectedError: /at least one block/i },
  ])("rejects $name", async ({ blocks, expectedError }) => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          blocks,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(expectedError);
  });

  it("requires at least one of content, blocks, or mediaUrl", async () => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content, blocks, or mediaUrl/i);
  });

  it("rejects blocks combined with mediaUrl", async () => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          blocks: [{ type: "divider" }],
          mediaUrl: "https://example.com/image.png",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/does not support blocks with mediaUrl/i);
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "Updated" } }]),
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Updated" } }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "divider" }],
      expectedBlocks: [{ type: "divider" }],
    },
  ])("passes $name to editSlackMessage", async ({ blocks, expectedBlocks }) => {
    await handleSlackAction(
      {
        action: "editMessage",
        channelId: "C123",
        messageId: "123.456",
        blocks,
      },
      slackConfig(),
    );
    expect(editSlackMessage).toHaveBeenCalledWith("C123", "123.456", "", {
      blocks: expectedBlocks,
    });
  });

  it("requires content or blocks for editMessage", async () => {
    await expect(
      handleSlackAction(
        {
          action: "editMessage",
          channelId: "C123",
          messageId: "123.456",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content or blocks/i);
  });

  it("auto-injects threadTs from context when replyToMode=all", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Auto-threaded",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "Auto-threaded", {
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
  });

  it("replyToMode=first threads first message then stops", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    // First message should be threaded
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "First" },
      cfg,
      context,
    );
    expectLastSlackSend("First", "1111111111.111111");
    expect(hasRepliedRef.value).toBe(true);

    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first marks hasRepliedRef even when threadTs is explicit", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit",
        threadTs: "2222222222.222222",
      },
      cfg,
      context,
    );
    expectLastSlackSend("Explicit", "2222222222.222222");
    expect(hasRepliedRef.value).toBe(true);

    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction({ action: "sendMessage", to: "channel:C123", content: "No ref" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
      // no hasRepliedRef
    });
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "No ref", {
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("does not auto-inject threadTs when replyToMode=off", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Off mode",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "off",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "Off mode", {
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("does not auto-inject threadTs when sending to different channel", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C999",
        content: "Different channel",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C999", "Different channel", {
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("explicit threadTs overrides context threadTs", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit thread",
        threadTs: "2222222222.222222",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "Explicit thread", {
      mediaUrl: undefined,
      threadTs: "2222222222.222222",
      blocks: undefined,
    });
  });

  it("handles channel target without prefix when replyToMode=all", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "C123",
        content: "No prefix",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("C123", "No prefix", {
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    readSlackMessages.mockResolvedValueOnce({
      messages: [{ ts: "1735689600.456", text: "hi" }],
      hasMore: false,
    });

    const result = await handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg);
    const payload = result.details as {
      messages: Array<{ timestampMs?: number; timestampUtc?: string }>;
    };

    const expectedMs = Math.round(1735689600.456 * 1000);
    expect(payload.messages[0].timestampMs).toBe(expectedMs);
    expect(payload.messages[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("passes threadId through to readSlackMessages", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    readSlackMessages.mockClear();
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    await handleSlackAction(
      { action: "readMessages", channelId: "C1", threadId: "12345.6789" },
      cfg,
    );

    const opts = readSlackMessages.mock.calls[0]?.[1] as { threadId?: string } | undefined;
    expect(opts?.threadId).toBe("12345.6789");
  });

  it("adds normalized timestamps to pin payloads", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    listSlackPins.mockResolvedValueOnce([
      {
        type: "message",
        message: { ts: "1735689600.789", text: "pinned" },
      },
    ]);

    const result = await handleSlackAction({ action: "listPins", channelId: "C1" }, cfg);
    const payload = result.details as {
      pins: Array<{ message?: { timestampMs?: number; timestampUtc?: string } }>;
    };

    const expectedMs = Math.round(1735689600.789 * 1000);
    expect(payload.pins[0].message?.timestampMs).toBe(expectedMs);
    expect(payload.pins[0].message?.timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("uses user token for reads when available", async () => {
    const cfg = {
      channels: { slack: { botToken: "xoxb-1", userToken: "xoxp-1" } },
    } as OpenClawConfig;
    expect(await resolveReadToken(cfg)).toBe("xoxp-1");
  });

  it("falls back to bot token for reads when user token missing", async () => {
    const cfg = {
      channels: { slack: { botToken: "xoxb-1" } },
    } as OpenClawConfig;
    expect(await resolveReadToken(cfg)).toBeUndefined();
  });

  it("uses bot token for writes when userTokenReadOnly is true", async () => {
    const cfg = {
      channels: { slack: { botToken: "xoxb-1", userToken: "xoxp-1" } },
    } as OpenClawConfig;
    expect(await resolveSendToken(cfg)).toBeUndefined();
  });

  it("allows user token writes when bot token is missing", async () => {
    const cfg = {
      channels: {
        slack: { userToken: "xoxp-1", userTokenReadOnly: false },
      },
    } as OpenClawConfig;
    expect(await resolveSendToken(cfg)).toBe("xoxp-1");
  });

  it("returns all emojis when no limit is provided", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const emojiMap = { wave: "url1", smile: "url2", heart: "url3" };
    listSlackEmojis.mockResolvedValueOnce({ ok: true, emoji: emojiMap });
    const result = await handleSlackAction({ action: "emojiList" }, cfg);
    const payload = result.details as { ok: boolean; emojis: { emoji: Record<string, string> } };
    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.emojis.emoji)).toHaveLength(3);
  });

  it("applies limit to emoji-list results", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const emojiMap = { wave: "url1", smile: "url2", heart: "url3", fire: "url4", star: "url5" };
    listSlackEmojis.mockResolvedValueOnce({ ok: true, emoji: emojiMap });
    const result = await handleSlackAction({ action: "emojiList", limit: 2 }, cfg);
    const payload = result.details as { ok: boolean; emojis: { emoji: Record<string, string> } };
    expect(payload.ok).toBe(true);
    const emojiKeys = Object.keys(payload.emojis.emoji);
    expect(emojiKeys).toHaveLength(2);
    expect(emojiKeys.every((k) => k in emojiMap)).toBe(true);
  });
});
