import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { WebInboundMsg } from "./types.js";
import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { markdownToWhatsApp } from "../../markdown/whatsapp.js";
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
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(replyResult.text || "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  // Standard retry: 3 attempts with linear backoff (500ms, 1s, 1.5s).
  // Disconnect-aware retry: when a disconnect-class error is detected, the
  // schedule escalates to 6 attempts with exponential backoff (1s, 2s, 4s,
  // 8s, 16s, 32s ≈ 63s total), giving the reconnection loop in
  // monitorWebChannel time to create a new socket.  The socketRef pattern
  // ensures each retry dereferences the *current* (potentially new) socket.
  const STANDARD = { maxAttempts: 3, baseMs: 500, factor: 1 };
  const DISCONNECT = { maxAttempts: 6, baseMs: 1_000, factor: 2 };

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string) => {
    let lastErr: unknown;
    let strategy = STANDARD;

    for (let attempt = 1; attempt <= strategy.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatError(err);
        const isDisconnect = /closed|reset|timed\s*out|disconnect|no active socket/i.test(errText);

        // On first disconnect error, escalate to extended retry schedule.
        if (isDisconnect && strategy === STANDARD) {
          strategy = DISCONNECT;
        }

        const isLast = attempt >= strategy.maxAttempts;
        if (!isDisconnect || isLast) {
          throw err;
        }

        const backoffMs =
          strategy.factor === 1
            ? strategy.baseMs * attempt
            : strategy.baseMs * Math.pow(strategy.factor, attempt - 1);
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${strategy.maxAttempts}) in ${backoffMs}ms: ${errText}`,
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
      const media = await loadWebMedia(mediaUrl, maxMediaBytes);
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
          err instanceof Error ? `⚠️ Media failed: ${err.message}` : "⚠️ Media failed.";
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
