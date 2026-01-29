import type { RequestClient } from "@buape/carbon";

import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import type { RuntimeEnv } from "../../runtime.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord } from "../send.js";
import { cacheBotMessage } from "./listeners.js";

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) continue;
    const replyTo = params.replyToId?.trim() || undefined;

    if (mediaList.length === 0) {
      let isFirstChunk = true;
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) chunks.push(text);
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const result = await sendMessageDiscord(params.target, trimmed, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo: isFirstChunk ? replyTo : undefined,
        });
        // Cache bot message for reaction trigger feature
        if (result.messageId && result.messageId !== "unknown") {
          cacheBotMessage({
            channelId: result.channelId,
            messageId: result.messageId,
            content: trimmed,
          });
        }
        isFirstChunk = false;
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) continue;
    const mediaResult = await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      replyTo,
    });
    // Cache bot message for reaction trigger feature
    if (mediaResult.messageId && mediaResult.messageId !== "unknown" && text) {
      cacheBotMessage({
        channelId: mediaResult.channelId,
        messageId: mediaResult.messageId,
        content: text,
      });
    }
    for (const extra of mediaList.slice(1)) {
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
        accountId: params.accountId,
      });
    }
  }
}
