import { GrammyError } from "grammy";
import { logVerbose, warn } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { retryAsync } from "../../infra/retry.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import { resolveTelegramMediaPlaceholder } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";

const FILE_TOO_BIG_RE = /file is too big/i;
const TELEGRAM_MEDIA_SSRF_POLICY = {
  // Telegram file downloads should trust api.telegram.org even when DNS/proxy
  // resolution maps to private/internal ranges in restricted networks.
  allowedHostnames: ["api.telegram.org"],
  allowRfc2544BenchmarkRange: true,
};

/**
 * Returns true if the error is Telegram's "file is too big" error.
 * This happens when trying to download files >20MB via the Bot API.
 * Unlike network errors, this is a permanent error and should not be retried.
 */
function isFileTooBigError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return FILE_TOO_BIG_RE.test(err.description);
  }
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if the error is a transient network error that should be retried.
 * Returns false for permanent errors like "file is too big" (400 Bad Request).
 */
function isRetryableGetFileError(err: unknown): boolean {
  // Don't retry "file is too big" - it's a permanent 400 error
  if (isFileTooBigError(err)) {
    return false;
  }
  // Retry all other errors (network issues, timeouts, etc.)
  return true;
}

export async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
} | null> {
  const msg = ctx.message;
  const downloadAndSaveTelegramFile = async (filePath: string, fetchImpl: typeof fetch) => {
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fetched = await fetchRemoteMedia({
      url,
      fetchImpl,
      filePathHint: filePath,
      maxBytes,
      ssrfPolicy: TELEGRAM_MEDIA_SSRF_POLICY,
    });
    const originalName = fetched.fileName ?? filePath;
    return saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);
  };

  // Handle stickers separately - only static stickers (WEBP) are supported
  if (msg.sticker) {
    const sticker = msg.sticker;
    // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
    if (sticker.is_animated || sticker.is_video) {
      logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
      return null;
    }
    if (!sticker.file_id) {
      return null;
    }

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        logVerbose("telegram: getFile returned no file_path for sticker");
        return null;
      }
      const fetchImpl = proxyFetch ?? globalThis.fetch;
      if (!fetchImpl) {
        logVerbose("telegram: fetch not available for sticker download");
        return null;
      }
      const saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);

      // Check sticker cache for existing description
      const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
      if (cached) {
        logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
        const fileId = sticker.file_id ?? cached.fileId;
        const emoji = sticker.emoji ?? cached.emoji;
        const setName = sticker.set_name ?? cached.setName;
        if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
          // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
          cacheSticker({
            ...cached,
            fileId,
            emoji,
            setName,
          });
        }
        return {
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
          stickerMetadata: {
            emoji,
            setName,
            fileId,
            fileUniqueId: sticker.file_unique_id,
            cachedDescription: cached.description,
          },
        };
      }

      // Cache miss - return metadata for vision processing
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:sticker>",
        stickerMetadata: {
          emoji: sticker.emoji ?? undefined,
          setName: sticker.set_name ?? undefined,
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
        },
      };
    } catch (err) {
      logVerbose(`telegram: failed to process sticker: ${String(err)}`);
      return null;
    }
  }

  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.video_note ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) {
    return null;
  }

  let file: { file_path?: string };
  try {
    file = await retryAsync(() => ctx.getFile(), {
      attempts: 3,
      minDelayMs: 1000,
      maxDelayMs: 4000,
      jitter: 0.2,
      label: "telegram:getFile",
      shouldRetry: isRetryableGetFileError,
      onRetry: ({ attempt, maxAttempts }) =>
        logVerbose(`telegram: getFile retry ${attempt}/${maxAttempts}`),
    });
  } catch (err) {
    // Handle "file is too big" separately - Telegram Bot API has a 20MB download limit
    if (isFileTooBigError(err)) {
      logVerbose(
        warn(
          "telegram: getFile failed - file exceeds Telegram Bot API 20MB limit; skipping attachment",
        ),
      );
      return null;
    }
    // All retries exhausted — return null so the message still reaches the agent
    // with a type-based placeholder (e.g. <media:audio>) instead of being dropped.
    logVerbose(`telegram: getFile failed after retries: ${String(err)}`);
    return null;
  }
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  const saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);
  const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}
