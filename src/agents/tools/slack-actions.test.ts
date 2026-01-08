import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { handleSlackAction } from "./slack-actions.js";

const deleteSlackMessage = vi.fn(async () => ({}));
const editSlackMessage = vi.fn(async () => ({}));
const getSlackMemberInfo = vi.fn(async () => ({}));
const listSlackEmojis = vi.fn(async () => ({}));
const listSlackPins = vi.fn(async () => ({}));
const listSlackReactions = vi.fn(async () => ({}));
const pinSlackMessage = vi.fn(async () => ({}));
const reactSlackMessage = vi.fn(async () => ({}));
const readSlackMessages = vi.fn(async () => ({}));
const removeOwnSlackReactions = vi.fn(async () => ["thumbsup"]);
const removeSlackReaction = vi.fn(async () => ({}));
const sendSlackMessage = vi.fn(async () => ({}));
const unpinSlackMessage = vi.fn(async () => ({}));

vi.mock("../../slack/actions.js", () => ({
  deleteSlackMessage: (...args: unknown[]) => deleteSlackMessage(...args),
  editSlackMessage: (...args: unknown[]) => editSlackMessage(...args),
  getSlackMemberInfo: (...args: unknown[]) => getSlackMemberInfo(...args),
  listSlackEmojis: (...args: unknown[]) => listSlackEmojis(...args),
  listSlackPins: (...args: unknown[]) => listSlackPins(...args),
  listSlackReactions: (...args: unknown[]) => listSlackReactions(...args),
  pinSlackMessage: (...args: unknown[]) => pinSlackMessage(...args),
  reactSlackMessage: (...args: unknown[]) => reactSlackMessage(...args),
  readSlackMessages: (...args: unknown[]) => readSlackMessages(...args),
  removeOwnSlackReactions: (...args: unknown[]) =>
    removeOwnSlackReactions(...args),
  removeSlackReaction: (...args: unknown[]) => removeSlackReaction(...args),
  sendSlackMessage: (...args: unknown[]) => sendSlackMessage(...args),
  unpinSlackMessage: (...args: unknown[]) => unpinSlackMessage(...args),
}));

describe("handleSlackAction", () => {
  it("adds reactions", async () => {
    const cfg = { slack: { botToken: "tok" } } as ClawdbotConfig;
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactSlackMessage).toHaveBeenCalledWith("C1", "123.456", "✅");
  });

  it("removes reactions on empty emoji", async () => {
    const cfg = { slack: { botToken: "tok" } } as ClawdbotConfig;
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "",
      },
      cfg,
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456");
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = { slack: { botToken: "tok" } } as ClawdbotConfig;
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C1", "123.456", "✅");
  });

  it("rejects removes without emoji", async () => {
    const cfg = { slack: { botToken: "tok" } } as ClawdbotConfig;
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "",
          remove: true,
        },
        cfg,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    const cfg = {
      slack: { botToken: "tok", actions: { reactions: false } },
    } as ClawdbotConfig;
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
  });

  it("passes threadTs to sendSlackMessage for thread replies", async () => {
    const cfg = { slack: { botToken: "tok" } } as ClawdbotConfig;
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
      },
      cfg,
    );
    expect(sendSlackMessage).toHaveBeenCalledWith("channel:C123", "Hello thread", {
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
    });
  });
});
