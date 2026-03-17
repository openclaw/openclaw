import type { ChannelOutboundAdapter } from "../types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../../../telegram/outbound-params.js";
import { sendMessageTelegram } from "../../../telegram/send.js";

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
  }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({ to, payload, mediaLocalRoots, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const telegramData = payload.channelData?.telegram as
      | { buttons?: Array<Array<{ text: string; callback_data: string }>>; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const baseOpts = {
      verbose: false,
      textMode: "html" as const,
      messageThreadId,
      replyToMessageId,
      quoteText,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
    };

    if (mediaUrls.length === 0) {
      // Chunk long text messages to stay within Telegram's 4096 char limit.
      const TEXT_LIMIT = 4000;
      const chunks = markdownToTelegramHtmlChunks(text, TEXT_LIMIT);
      if (chunks.length <= 1) {
        // Single chunk (or empty) — send with buttons as before.
        const result = await send(to, chunks[0] ?? text, {
          ...baseOpts,
          buttons: telegramData?.buttons,
        });
        return { channel: "telegram", ...result };
      }
      // Multiple chunks — send all but last as plain text, attach buttons to last only.
      let finalResult: Awaited<ReturnType<typeof send>> | undefined;
      for (let i = 0; i < chunks.length; i += 1) {
        const isLast = i === chunks.length - 1;
        finalResult = await send(to, chunks[i], {
          ...baseOpts,
          // Only attach reply context + quote to first chunk, buttons to last.
          replyToMessageId: i === 0 ? replyToMessageId : undefined,
          quoteText: i === 0 ? quoteText : undefined,
          ...(isLast ? { buttons: telegramData?.buttons } : {}),
        });
      }
      return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
    }

    // Telegram allows reply_markup on media; attach buttons only to first send.
    let finalResult: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < mediaUrls.length; i += 1) {
      const mediaUrl = mediaUrls[i];
      const isFirst = i === 0;
      finalResult = await send(to, isFirst ? text : "", {
        ...baseOpts,
        mediaUrl,
        ...(isFirst ? { buttons: telegramData?.buttons } : {}),
      });
    }
    return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
  },
};
