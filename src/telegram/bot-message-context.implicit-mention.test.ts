import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext implicitMention forum system messages", () => {
  /**
   * Build a group message context where the user sends a message inside a
   * forum topic that has `reply_to_message` pointing to a message from the
   * bot.  Callers control whether the reply target looks like a system
   * message (empty text) or a real bot reply (non-empty text).
   */
  async function buildGroupReplyCtx(params: {
    replyToMessageText?: string;
    replyToMessageCaption?: string;
    replyFromIsBot?: boolean;
    replyFromId?: number;
  }) {
    const BOT_ID = 7; // matches test harness primaryCtx.me.id
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum Group" },
        date: 1700000000,
        text: "hello everyone",
        from: { id: 42, first_name: "Alice" },
        reply_to_message: {
          message_id: 1,
          text: params.replyToMessageText ?? undefined,
          ...(params.replyToMessageCaption != null
            ? { caption: params.replyToMessageCaption }
            : {}),
          from: {
            id: params.replyFromId ?? BOT_ID,
            first_name: "OpenClaw",
            is_bot: params.replyFromIsBot ?? true,
          },
        },
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });
  }

  it("does NOT trigger implicitMention for forum topic system messages (empty-text bot message)", async () => {
    // System message: bot created the topic → text is empty, from.is_bot = true
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyFromIsBot: true,
    });

    // With requireMention and no explicit @mention, the message should be
    // skipped (null) because implicitMention should NOT fire.
    expect(ctx).toBeNull();
  });

  it("does NOT trigger implicitMention for empty-string text system messages", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "",
      replyFromIsBot: true,
    });

    expect(ctx).toBeNull();
  });

  it("DOES trigger implicitMention for real bot replies (non-empty text)", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "Here is my answer",
      replyFromIsBot: true,
    });

    // Real bot reply → implicitMention fires → message is NOT skipped.
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot reply with whitespace-only text", async () => {
    // A bot message that has actual whitespace text is NOT a system message,
    // so it should still count as an implicit mention.  (Telegram's forum
    // system messages have undefined / empty text, not whitespace.)
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: " ",
      replyFromIsBot: true,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot media messages with caption (not a system message)", async () => {
    // Media messages from the bot have caption but no text — they should
    // still count as real bot replies, not system messages.
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyToMessageCaption: "Check out this image",
      replyFromIsBot: true,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("does NOT trigger implicitMention when reply is from a different user", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "some message",
      replyFromIsBot: false,
      replyFromId: 999,
    });

    // Different user's message → not an implicit mention → skipped.
    expect(ctx).toBeNull();
  });
});
