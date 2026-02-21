import { serializePayload, type RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { splitMarkdownTables } from "../../markdown/table-split.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { isTableImageRendererAvailable, renderTableImage } from "../../media/table-image.js";
import type { RuntimeEnv } from "../../runtime.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord, sendVoiceMessageDiscord } from "../send.js";
import { buildDiscordMessagePayload, stripUndefinedFields } from "../send.shared.js";

// ---------------------------------------------------------------------------
// File attachment helper — posts raw buffer data directly so it bypasses the
// loadWebMedia() path (which can recompress PNGs to JPEG).
// ---------------------------------------------------------------------------

/** Resolve a routed target like `channel:123456` to a raw snowflake. */
function resolveRawChannelId(target: string): string {
  return target.startsWith("channel:") ? target.slice("channel:".length) : target;
}

async function sendDiscordFileBuffer(params: {
  rest: RequestClient;
  channelId: string;
  fileName: string;
  contentType: string;
  data: Buffer;
  caption?: string;
  replyTo?: string;
}) {
  const rawChannelId = resolveRawChannelId(params.channelId);
  const arrayBuffer = new ArrayBuffer(params.data.byteLength);
  new Uint8Array(arrayBuffer).set(params.data);
  const blob = new Blob([arrayBuffer], { type: params.contentType });
  const payload = buildDiscordMessagePayload({
    text: params.caption ?? "",
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
// Image table delivery — split text into segments, render tables as PNG,
// send text chunks normally and table images as file attachments.
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
  chunkMode?: ChunkMode;
}): Promise<boolean> {
  const { rawText, rest, runtime } = params;
  if (!rest) {
    return false;
  }

  const available = await isTableImageRendererAvailable();
  if (!available) {
    return false;
  }

  const segments = splitMarkdownTables(rawText);

  // If segmentation found no tables, let the caller fall through to standard delivery.
  const hasTableSegment = segments.some((s) => s.kind === "table");
  if (!hasTableSegment) {
    return false;
  }

  const mode = params.chunkMode ?? "length";

  for (const segment of segments) {
    if (segment.kind === "text") {
      // Convert any remaining table-like markup to code as a safety net
      const text = convertMarkdownTables(segment.markdown, "code");
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: params.chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
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
    } else {
      // Render the table to a PNG image
      const result = await renderTableImage(segment.markdown, segment.index);
      if (result) {
        try {
          await sendDiscordFileBuffer({
            rest,
            channelId: params.target,
            fileName: result.fileName,
            contentType: "image/png",
            data: result.png,
            replyTo: params.replyTo,
          });
        } catch (err) {
          // Fire-and-forget: log and fall back to text
          const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
          runtime.error?.(`discord: table image send failed, falling back to text: ${errMsg}`);
          const fallback = convertMarkdownTables(result.fallbackMarkdown, "code");
          if (fallback.trim()) {
            await sendMessageDiscord(params.target, fallback, {
              token: params.token,
              rest: params.rest,
              accountId: params.accountId,
              replyTo: params.replyTo,
            });
          }
        }
      } else {
        // Renderer returned null — fall back to code table
        const fallback = convertMarkdownTables(segment.markdown, "code");
        if (fallback.trim()) {
          await sendMessageDiscord(params.target, fallback, {
            token: params.token,
            rest: params.rest,
            accountId: params.accountId,
            replyTo: params.replyTo,
          });
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
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const replyTo = params.replyToId?.trim() || undefined;

    // Image table path: when configured, always try segmentation (don't
    // pre-gate on hasMarkdownTable — let splitMarkdownTables decide).
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
        chunkMode: params.chunkMode,
      });
      if (delivered) {
        continue;
      }
      // Fall through to standard text delivery if renderer unavailable
    }

    // Standard text delivery (with text-based table conversion)
    const effectiveTableMode = tableMode === "image" ? "code" : tableMode;
    const text = convertMarkdownTables(rawText, effectiveTableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }

    if (mediaList.length === 0) {
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
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
          replyTo,
        });
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }

    // Voice message path: audioAsVoice flag routes through sendVoiceMessageDiscord
    if (payload.audioAsVoice) {
      await sendVoiceMessageDiscord(params.target, firstMedia, {
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo,
      });
      // Voice messages cannot include text; send remaining text separately if present
      if (text.trim()) {
        await sendMessageDiscord(params.target, text, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo,
        });
      }
      // Additional media items are sent as regular attachments (voice is single-file only)
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
