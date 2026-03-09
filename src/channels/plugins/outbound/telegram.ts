import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import type { TelegramInlineButtons } from "../../../telegram/button-types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../../../telegram/outbound-params.js";
import { sendMessageTelegram } from "../../../telegram/send.js";
import type { ChannelOutboundAdapter } from "../types.js";

function resolveTelegramSendContext(params: {
  cfg: NonNullable<Parameters<typeof sendMessageTelegram>[2]>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
}): {
  send: typeof sendMessageTelegram;
  baseOpts: {
    cfg: NonNullable<Parameters<typeof sendMessageTelegram>[2]>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
  };
} {
  const send = params.deps?.sendTelegram ?? sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
    },
  };
}

function chunkTelegramRawHtml(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  // Prefer splitting on double-newlines to keep paragraphs intact.
  const blocks = text.split(/\n\n+/g);
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    flush();

    // If a single block is still too large, hard-slice it.
    if (block.length <= limit) {
      current = block;
      continue;
    }

    for (let i = 0; i < block.length; i += limit) {
      chunks.push(block.slice(i, i + limit));
    }
  }

  flush();
  return chunks;
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  // IMPORTANT: sendText is chunked in deliver.ts using this chunker; it expects markdown -> telegram-html.
  // sendPayload must preserve raw HTML, so it uses a separate raw chunker inside sendPayload.
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  // Keep the existing chunk limit (slightly under the Telegram 4096 limit).
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const result = await send(to, text, {
      ...baseOpts,
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
  }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const result = await send(to, text, {
      ...baseOpts,
      mediaUrl,
      mediaLocalRoots,
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
  }) => {
    const { send, baseOpts: contextOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const telegramData = payload.channelData?.telegram as
      | { buttons?: TelegramInlineButtons; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const rawText = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    // NOTE: deliver.ts chunks long Telegram text for sendText paths, but sendPayload bypasses
    // that code path. Chunk here to avoid Telegram 400 "message is too long" errors.
    // Preserve RAW HTML in this path (no escaping/transformation).
    // NOTE: chunkTelegramRawHtml may hard-slice long strings, which can split HTML tags.
    // We intentionally do NOT attempt an HTML-aware chunker here (future work) to keep this fix small.
    let textChunks = chunkTelegramRawHtml(rawText, telegramOutbound.textChunkLimit ?? 4000);

    const basePayloadOpts = {
      ...contextOpts,
      mediaLocalRoots,
    };

    const sendTextChunk = async (text: string, opts: { isFirst: boolean }) =>
      send(to, text, {
        ...basePayloadOpts,
        quoteText: opts.isFirst ? quoteText : undefined,
        // Only attach inline buttons to the first message to preserve current behaviour.
        ...(opts.isFirst ? { buttons: telegramData?.buttons } : {}),
        // Only reply-to on the first chunk; thread context stays for all chunks.
        ...(opts.isFirst ? {} : { replyToMessageId: undefined }),
      });

    if (mediaUrls.length === 0) {
      // Prevent silent "success" when there is nothing to send.
      // If buttons exist without text, Telegram still needs a message body; use an invisible placeholder.
      if (textChunks.length === 0) {
        if (telegramData?.buttons?.length) {
          textChunks = ["\u2063"]; // INVISIBLE SEPARATOR
        } else {
          throw new Error("telegramOutbound.sendPayload: empty payload (no text, no media)");
        }
      }

      let finalResult: Awaited<ReturnType<typeof send>> | undefined;
      for (let i = 0; i < textChunks.length; i += 1) {
        finalResult = await sendTextChunk(textChunks[i] ?? "", { isFirst: i === 0 });
      }
      return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
    }

    // Telegram allows reply_markup on media; attach buttons only to first send.
    // If text exceeds the limit, we attach the first chunk to the first media caption,
    // then send remaining chunks as follow-up text messages.
    let finalResult: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < mediaUrls.length; i += 1) {
      const mediaUrl = mediaUrls[i];
      const isFirstMedia = i === 0;
      const caption = isFirstMedia ? (textChunks[0] ?? "") : "";
      finalResult = await send(to, caption, {
        ...basePayloadOpts,
        quoteText: isFirstMedia ? quoteText : undefined,
        mediaUrl,
        ...(isFirstMedia ? { buttons: telegramData?.buttons } : {}),
        ...(isFirstMedia ? {} : { replyToMessageId: undefined }),
      });
    }

    for (let i = 1; i < textChunks.length; i += 1) {
      finalResult = await sendTextChunk(textChunks[i] ?? "", { isFirst: false });
    }

    return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
  },
};
