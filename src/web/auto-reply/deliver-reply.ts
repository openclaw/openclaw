import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { WebInboundMsg } from "./types.js";
import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { sleep } from "../../utils.js";
import { loadWebMedia } from "../media.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappOutboundLog } from "./loggers.js";
import { elide } from "./util.js";

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}) {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const replyStarted = Date.now();
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";

  // WhatsApp safety: never forward internal tool banners/log lines into chats.
  // These are usually from agent/tool failures and look like:
  // "⚠️ 🛠️ Exec: ...", "Command exited with code ...", etc.
  const rawText = replyResult.text || "";
  const sanitizedText = rawText
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) {
        return true;
      }
      if (/^⚠️\s*🛠️\s*(Exec|Read|Edit|Cron|Tool)\b/i.test(t)) {
        return false;
      }
      if (/^(Exec|Read|Edit|Cron|Tool):\s*/i.test(t)) {
        return false;
      }
      if (/^Command exited with code\s+\d+/i.test(t)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  const convertedText = convertMarkdownTables(sanitizedText, tableMode);
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  if (mediaList.length === 0 && textChunks.length === 0) {
    // Entire reply was internal noise.
    return;
  }

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string, maxAttempts = 3) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatError(err);
        const isLast = attempt === maxAttempts;
        const shouldRetry = /closed|reset|timed\\s*out|disconnect/i.test(errText);
        if (!shouldRetry || isLast) {
          throw err;
        }
        const backoffMs = 500 * attempt;
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${errText}`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      await sendWithRetry(() => msg.reply(chunk), "text");
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: elide(replyResult.text, 240),
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    return;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  for (const [index, mediaUrl] of mediaList.entries()) {
    const caption = index === 0 ? remainingText.shift() || undefined : undefined;

    // Guard: sometimes model output includes placeholder strings like "image"/"document" or pasted instructions.
    // Only treat values as media sources if they look like an http(s) URL, file:// URL, or a local path.
    const rawMediaUrl = String(mediaUrl ?? "");
    const normalized = rawMediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
    const isRemote = /^https?:\/\//i.test(normalized);
    const isFileUrl = /^file:\/\//i.test(normalized);

    // Accept:
    // - absolute paths (/...)
    // - explicit relative paths (./..., ../...)
    // - home paths (~/...)
    // - plain relative paths like "image.png" or "images/foo.jpg" (regression guard)
    // Reject:
    // - placeholders like "image" / "document" (no extension)
    const hasSeparator = normalized.includes("/") || normalized.includes("\\\\");
    const hasExtension = /\.[A-Za-z0-9]{2,8}$/.test(normalized);
    const startsLikePath =
      normalized.startsWith("/") ||
      normalized.startsWith("./") ||
      normalized.startsWith("../") ||
      normalized.startsWith("~/") ||
      normalized === "~";
    const isPlainRelativePath = (hasSeparator || hasExtension) && !/\s/.test(normalized);

    const isLocalPath = startsLikePath || isPlainRelativePath;

    if (!isRemote && !isFileUrl && !isLocalPath) {
      whatsappOutboundLog.warn(
        `Skipping invalid mediaUrl candidate for ${msg.from}: ${elide(rawMediaUrl, 120)}`,
      );
      if (index === 0 && caption) {
        await sendWithRetry(() => msg.reply(caption), "text");
      }
      continue;
    }

    try {
      const media = await loadWebMedia(normalized, maxMediaBytes);
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      if (media.kind === "image") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              image: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:image",
        );
      } else if (media.kind === "audio") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              audio: media.buffer,
              ptt: true,
              mimetype: media.contentType,
              caption,
            }),
          "media:audio",
        );
      } else if (media.kind === "video") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              video: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:video",
        );
      } else {
        const fileName = media.fileName ?? mediaUrl.split("/").pop() ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        await sendWithRetry(
          () =>
            msg.sendMedia({
              document: media.buffer,
              fileName,
              caption,
              mimetype,
            }),
          "media:document",
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: caption ?? null,
          mediaUrl: normalized,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    } catch (err) {
      whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(err)}`);
      replyLogger.warn({ err, mediaUrl }, "failed to send web media reply");
      if (index === 0) {
        // Never leak internal/technical errors into user chats.
        // If media fails, just send the intended text (caption/body) without warnings.
        const fallbackText = (remainingText.shift() ?? caption ?? "").trim();
        if (fallbackText) {
          whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
          await msg.reply(fallbackText);
        }
      }
    }
  }

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    await msg.reply(chunk);
  }
}
