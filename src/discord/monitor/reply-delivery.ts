import { serializePayload, type RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { logVerbose } from "../../globals.js";
import { splitMarkdownTables } from "../../markdown/table-split.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { renderTableImage } from "../../media/table-image.js";
import type { RuntimeEnv } from "../../runtime.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord, sendVoiceMessageDiscord } from "../send.js";
import { buildDiscordMessagePayload, stripUndefinedFields } from "../send.shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a routed target like `channel:123456` or `discord:channel:123456` to a raw snowflake. */
function resolveRawChannelId(target: string): string {
  if (target.startsWith("discord:channel:")) {
    return target.slice("discord:channel:".length);
  }
  if (target.startsWith("channel:")) {
    return target.slice("channel:".length);
  }
  return target;
}

/** Send chunked text via the standard Discord message path. */
async function sendChunkedText(
  text: string,
  params: {
    target: string;
    token: string;
    accountId?: string;
    rest?: RequestClient;
    replyTo?: string;
    chunkLimit: number;
    maxLinesPerMessage?: number;
    chunkMode: ChunkMode;
  },
) {
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: params.chunkLimit,
    maxLines: params.maxLinesPerMessage,
    chunkMode: params.chunkMode,
  });
  if (!chunks.length && text) {
    chunks.push(text);
  }
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    await sendMessageDiscord(params.target, trimmed, {
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      replyTo: params.replyTo,
    });
  }
}

/**
 * Post a raw buffer as a file attachment (bypasses loadWebMedia JPEG recompression).
 * Uses rest.post directly (no RetryRunner) — transient failures fall through to the
 * text fallback in the caller, which is faster than retrying a file upload.
 */
async function sendDiscordFileBuffer(params: {
  rest: RequestClient;
  channelId: string;
  fileName: string;
  contentType: string;
  data: Buffer;
  replyTo?: string;
}) {
  const rawChannelId = resolveRawChannelId(params.channelId);
  const arrayBuffer = new ArrayBuffer(params.data.byteLength);
  new Uint8Array(arrayBuffer).set(params.data);
  const blob = new Blob([arrayBuffer], { type: params.contentType });
  const payload = buildDiscordMessagePayload({
    text: "",
    files: [{ data: blob, name: params.fileName }],
  });
  const messageReference = params.replyTo
    ? { message_id: params.replyTo, fail_if_not_exists: false }
    : undefined;

  await params.rest.post(Routes.channelMessages(rawChannelId), {
    body: stripUndefinedFields({
      ...serializePayload(payload),
      ...(messageReference ? { message_reference: messageReference } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Image table delivery
// ---------------------------------------------------------------------------

async function deliverWithTableImages(params: {
  rawText: string;
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  chunkLimit: number;
  maxLinesPerMessage?: number;
  replyTo?: string;
  chunkMode: ChunkMode;
}): Promise<boolean> {
  const { rawText, rest } = params;
  if (!rest) {
    return false;
  }

  const segments = splitMarkdownTables(rawText);
  if (!segments.some((s) => s.kind === "table")) {
    return false;
  }

  for (const segment of segments) {
    if (segment.kind === "text") {
      const text = convertMarkdownTables(segment.markdown, "code");
      await sendChunkedText(text, params);
    } else {
      const png = await renderTableImage(segment.markdown);
      if (png) {
        try {
          await sendDiscordFileBuffer({
            rest,
            channelId: params.target,
            fileName: `table-${segment.index + 1}.png`,
            contentType: "image/png",
            data: png,
            replyTo: params.replyTo,
          });
        } catch (err) {
          logVerbose(
            `discord: table image send failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
          );
          const fallback = convertMarkdownTables(segment.markdown, "code");
          if (fallback.trim()) {
            await sendChunkedText(fallback, params);
          }
        }
      } else {
        const fallback = convertMarkdownTables(segment.markdown, "code");
        if (fallback.trim()) {
          await sendChunkedText(fallback, params);
        }
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main delivery function
// ---------------------------------------------------------------------------

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
  const mode = params.chunkMode ?? "length";

  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const replyTo = params.replyToId?.trim() || undefined;

    // Image table path: segment text, render tables as PNG, send text normally.
    if (tableMode === "image" && mediaList.length === 0) {
      const delivered = await deliverWithTableImages({
        rawText,
        target: params.target,
        token: params.token,
        accountId: params.accountId,
        rest: params.rest,
        runtime: params.runtime,
        chunkLimit,
        maxLinesPerMessage: params.maxLinesPerMessage,
        replyTo,
        chunkMode: mode,
      });
      if (delivered) {
        continue;
      }
    }

    // Standard text delivery
    const effectiveTableMode = tableMode === "image" ? "code" : tableMode;
    const text = convertMarkdownTables(rawText, effectiveTableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }

    if (mediaList.length === 0) {
      await sendChunkedText(text, {
        target: params.target,
        token: params.token,
        accountId: params.accountId,
        rest: params.rest,
        replyTo,
        chunkLimit,
        maxLinesPerMessage: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }

    // Voice message path
    if (payload.audioAsVoice) {
      await sendVoiceMessageDiscord(params.target, firstMedia, {
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo,
      });
      if (text.trim()) {
        await sendMessageDiscord(params.target, text, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo,
        });
      }
      for (const extra of mediaList.slice(1)) {
        await sendMessageDiscord(params.target, "", {
          token: params.token,
          rest: params.rest,
          mediaUrl: extra,
          accountId: params.accountId,
          replyTo,
        });
      }
      continue;
    }

    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      replyTo,
    });
    for (const extra of mediaList.slice(1)) {
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
        accountId: params.accountId,
        replyTo,
      });
    }
  }
}
