import type { TelegramInlineButtons } from "../../../telegram/button-types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../../../telegram/outbound-params.js";
import { sendMessageTelegram } from "../../../telegram/send.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { buildTelegramRawSend, type TelegramButtons } from "../mux-envelope.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, sessionKey }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "telegram",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        replyToId,
        threadId,
        raw: {
          telegram: buildTelegramRawSend({
            to,
            text,
            messageThreadId,
            replyToMessageId,
          }),
        },
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    sessionKey,
  }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "telegram",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        replyToId,
        threadId,
        raw: {
          telegram: buildTelegramRawSend({
            to,
            text,
            mediaUrl,
            messageThreadId,
            replyToMessageId,
          }),
        },
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
  sendPayload: async ({ cfg, to, payload, mediaLocalRoots, accountId, deps, replyToId, threadId, sessionKey }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const telegramData = payload.channelData?.telegram as
      | { buttons?: TelegramButtons; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      if (mediaUrls.length === 0) {
        const result = await sendViaMux({
          cfg,
          channel: "telegram",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text,
          replyToId,
          threadId,
          channelData:
            typeof payload.channelData === "object" && payload.channelData !== null
              ? payload.channelData
              : undefined,
          raw: {
            telegram: buildTelegramRawSend({
              to,
              text,
              buttons: telegramData?.buttons,
              quoteText,
              messageThreadId,
              replyToMessageId,
            }),
          },
        });
        return { channel: "telegram", ...result };
      }

      let finalResult:
        | {
            messageId: string;
            chatId?: string;
            channelId?: string;
            toJid?: string;
            conversationId?: string;
            pollId?: string;
          }
        | undefined;
      for (let i = 0; i < mediaUrls.length; i += 1) {
        const mediaUrl = mediaUrls[i];
        const isFirst = i === 0;
        finalResult = await sendViaMux({
          cfg,
          channel: "telegram",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text: isFirst ? text : "",
          mediaUrl,
          replyToId,
          threadId,
          channelData:
            typeof payload.channelData === "object" && payload.channelData !== null
              ? payload.channelData
              : undefined,
          raw: {
            telegram: buildTelegramRawSend({
              to,
              text: isFirst ? text : "",
              mediaUrl,
              buttons: isFirst ? telegramData?.buttons : undefined,
              quoteText,
              messageThreadId,
              replyToMessageId,
            }),
          },
        });
      }
      return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
      const result = await send(to, text, {
        ...baseOpts,
        buttons: telegramData?.buttons,
      });
      return { channel: "telegram", ...result };
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
