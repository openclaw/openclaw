import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { markdownToWhatsApp } from "../../markdown/whatsapp.js";
import { sleep } from "../../utils.js";
import { loadWebMedia } from "../media.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappOutboundLog } from "./loggers.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

/**
 * Sanitize an error message for user-facing display.
 * Strips PII (phone numbers, group IDs), internal paths, and raw JSON dumps.
 * Returns a short, generic reason suitable for chat messages.
 */
function sanitizeMediaError(raw: string): string {
  // Known safe short reasons we can pass through directly.
  const safeReasons: RegExp[] = [
    /\btimeout\b/i,
    /\bnetwork\b/i,
    /\bfetch failed\b/i,
    /\bECONNREFUSED\b/i,
    /\bECONNRESET\b/i,
    /\bENOTFOUND\b/i,
    /\b404\b/,
    /\b403\b/,
    /\b413\b/,
    /\b5\d{2}\b/,
    /\btoo large\b/i,
    /\bnot found\b/i,
    /\bforbidden\b/i,
    /\bunsupported\b/i,
    /\binvalid url\b/i,
  ];

  for (const re of safeReasons) {
    const m = raw.match(re);
    if (m) return m[0];
  }

  // If the message looks like it contains PII or metadata, redact entirely.
  const piiPatterns = [
    /\+\d{7,15}/, // phone numbers
    /@[gs]\.us/, // WhatsApp group/user JIDs
    /[A-Za-z]:\\/, // Windows paths
    /\/home\//, // Unix paths
    /\{[\s\S]{20,}/, // JSON dumps (opening brace + long content)
  ];

  for (const re of piiPatterns) {
    if (re.test(raw)) return "download failed";
  }

  // Truncate to avoid leaking anything unexpected.
  const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
  if (cleaned.length > 80) return "download failed";

  return cleaned;
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  mediaLocalRoots?: readonly string[];
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
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(replyResult.text || "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

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
    try {
      const media = await loadWebMedia(mediaUrl, {
        maxBytes: maxMediaBytes,
        localRoots: params.mediaLocalRoots,
      });
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
          mediaUrl,
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
        const warning =
          err instanceof Error
            ? `⚠️ Media failed: ${sanitizeMediaError(err.message)}`
            : "⚠️ Media failed.";
        const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean);
        const fallbackText = fallbackTextParts.join("\n");
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
