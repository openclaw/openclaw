// Session origin must drop the prior channel's identity when a dmScope:"main" session moves
// across providers, so channel-keyed fields do not reference a now-inactive channel.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

const sessionKey = "agent:user";

function applyOrigin(existing: SessionEntry | undefined, ctx: Partial<MsgContext>): SessionEntry {
  const patch = deriveSessionMetaPatch({
    ctx: ctx as MsgContext,
    sessionKey,
    existing,
  });
  return { ...(existing ?? {}), ...(patch ?? {}) } as SessionEntry;
}

const slackTurn = {
  Provider: "slack",
  Surface: "slack",
  ChatType: "direct",
  From: "slack:U0001",
  To: "slack:D111SLACK",
  NativeChannelId: "D111SLACK",
  NativeDirectUserId: "U0001",
  AccountId: "slack-team-1",
  MessageThreadId: "1700000000.000100",
} satisfies Partial<MsgContext>;

const telegramTurn = {
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
  From: "telegram:42",
  To: "telegram:42",
  AccountId: "telegram-bot-1",
} satisfies Partial<MsgContext>;

describe("session origin across a channel switch", () => {
  it("clears stale channel-keyed fields when provider changes and the new turn omits them", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterSlack.origin?.threadId).toBe("1700000000.000100");

    const afterTelegram = applyOrigin(afterSlack, telegramTurn);

    // Provider/surface flip to Telegram, and the Slack-only identity must not survive.
    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.surface).toBe("telegram");
    expect(afterTelegram.origin?.accountId).toBe("telegram-bot-1");
    expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
    expect(afterTelegram.origin?.nativeDirectUserId).toBeUndefined();
    expect(afterTelegram.origin?.threadId).toBeUndefined();
  });

  it("does not re-stamp the prior channel id on subsequent same-channel turns", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterTelegram = applyOrigin(afterSlack, telegramTurn);
    const afterTelegramAgain = applyOrigin(afterTelegram, telegramTurn);

    expect(afterTelegramAgain.origin?.provider).toBe("telegram");
    expect(afterTelegramAgain.origin?.nativeChannelId).toBeUndefined();
    expect(afterTelegramAgain.origin?.threadId).toBeUndefined();
  });

  it("adopts the new channel's identity when the new turn supplies it", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const telegramWithChannel = {
      ...telegramTurn,
      NativeChannelId: "C222TG",
      MessageThreadId: 555,
    } satisfies Partial<MsgContext>;

    const afterTelegram = applyOrigin(afterSlack, telegramWithChannel);
    expect(afterTelegram.origin?.nativeChannelId).toBe("C222TG");
    expect(afterTelegram.origin?.threadId).toBe(555);
  });

  it("preserves sparse channel metadata across turns on the same provider", () => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const slackFollowUp = {
      Provider: "slack",
      Surface: "slack",
      ChatType: "direct",
      From: "slack:U0001",
      To: "slack:D111SLACK",
      AccountId: "slack-team-1",
    } satisfies Partial<MsgContext>;

    const afterFollowUp = applyOrigin(afterSlack, slackFollowUp);
    // Same provider: the established channel id and thread are retained when omitted.
    expect(afterFollowUp.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterFollowUp.origin?.threadId).toBe("1700000000.000100");
  });
});
