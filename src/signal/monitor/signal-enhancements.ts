/**
 * Signal Enhancements Module
 *
 * All Signal-specific enhancements (sticker support, quote/reply messages,
 * requireMention, persistent media cache, pre-cache, agent media cache) live here.
 * Upstream files only need minimal hook calls into this module.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEventHandlerDeps,
} from "./event-handler.types.js";
import { logVerbose } from "../../globals.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { resolveConfigDir } from "../../utils.js";

// ── Extended types (not modifying upstream types) ────────────────────────────

export type SignalQuotedAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
  thumbnail?: {
    data?: string | null;
    contentType?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
};

export type SignalQuote = {
  id?: number | null;
  author?: string | null;
  authorNumber?: string | null;
  authorName?: string | null;
  text?: string | null;
  attachments?: Array<SignalQuotedAttachment>;
};

export type SignalSticker = {
  packId?: string | null;
  packKey?: string | null;
  stickerId?: number | null;
  emoji?: string | null;
  contentType?: string | null;
  attachment?: {
    id?: string | null;
    contentType?: string | null;
    size?: number | null;
  } | null;
};

export type SignalMention = {
  start?: number;
  length?: number;
  uuid?: string | null;
  number?: string | null;
};

/** Upstream SignalDataMessage extended with sticker/quote/mention fields. */
type EnhancedDataMessage = SignalDataMessage & {
  quote?: SignalQuote | null;
  sticker?: SignalSticker | null;
  mentions?: Array<SignalMention> | null;
};

/** Cast upstream dataMessage to access extended fields. */
function asEnhanced(msg: SignalDataMessage | null | undefined): EnhancedDataMessage | null {
  return (msg as EnhancedDataMessage) ?? null;
}

// ── Enhancement deps (superset of upstream deps) ────────────────────────────

export type SignalEnhancementDeps = Pick<
  SignalEventHandlerDeps,
  | "cfg"
  | "baseUrl"
  | "account"
  | "accountId"
  | "mediaMaxBytes"
  | "ignoreAttachments"
  | "fetchAttachment"
> & {
  requireMention: boolean;
  fetchSticker?: (params: {
    baseUrl: string;
    account?: string;
    packId: string;
    stickerId: number;
    maxBytes: number;
  }) => Promise<{ path: string; contentType?: string } | null>;
};

// ── Pre-cache uses upstream's inbound/ directory directly ────────────────────
//
// fetchAttachment/fetchSticker both call saveMediaBuffer → ~/.openclaw/media/inbound/
// Files there are NOT TTL-cleaned (cleanup only targets ~/.openclaw/media/ root).
// We record the path in signal-media-precache.json for later lookup.
//
// All precache data (index + fallback files) lives under:
//   ~/.openclaw/media/inbound/signal_precache/

const PRECACHE_DIR = path.join(resolveConfigDir(), "media", "inbound", "signal_precache");

// ── Persistent media lookup cache (timestamp → path index) ──────────────────

type MediaCacheEntry = { path: string; contentType?: string; savedAt: number };
type MediaCacheData = Record<string, MediaCacheEntry>;

const MEDIA_CACHE_FILE = path.join(PRECACHE_DIR, "signal-media-precache.json");
const MEDIA_CACHE_MAX_SIZE = 50_000;
const MEDIA_CACHE_MAX_AGE_MS = 3650 * 24 * 60 * 60 * 1000; // ~10 years

let mediaCacheData: MediaCacheData = {};
let mediaCacheLoaded = false;
let savePending = false;

export async function loadSignalMediaCache(): Promise<void> {
  if (mediaCacheLoaded) {
    return;
  }
  try {
    const content = await fs.readFile(MEDIA_CACHE_FILE, "utf-8");
    mediaCacheData = JSON.parse(content) as MediaCacheData;
    const now = Date.now();
    for (const [key, entry] of Object.entries(mediaCacheData)) {
      if (now - entry.savedAt > MEDIA_CACHE_MAX_AGE_MS) {
        delete mediaCacheData[key];
      }
    }
    logVerbose(`signal media cache loaded: ${Object.keys(mediaCacheData).length} entries`);
  } catch {
    mediaCacheData = {};
  }
  mediaCacheLoaded = true;
}

async function persistMediaCache(): Promise<void> {
  if (savePending) {
    return; // debounce: only one write in flight
  }
  savePending = true;
  try {
    await fs.mkdir(path.dirname(MEDIA_CACHE_FILE), { recursive: true });
    await fs.writeFile(MEDIA_CACHE_FILE, JSON.stringify(mediaCacheData, null, 2));
  } catch (err) {
    logVerbose(`signal media cache save failed: ${String(err)}`);
  } finally {
    savePending = false;
  }
}

function cacheMedia(timestamp: number | undefined, media: { path: string; contentType?: string }) {
  if (!timestamp || !media.path) {
    return;
  }
  const key = String(timestamp);

  // Evict oldest entries when lookup cache is full
  const keys = Object.keys(mediaCacheData);
  if (keys.length >= MEDIA_CACHE_MAX_SIZE) {
    const sorted = keys.toSorted(
      (a, b) => (mediaCacheData[a]?.savedAt ?? 0) - (mediaCacheData[b]?.savedAt ?? 0),
    );
    for (let i = 0; i < 100 && i < sorted.length; i++) {
      const oldKey = sorted[i];
      if (oldKey) {
        delete mediaCacheData[oldKey];
      }
    }
  }

  mediaCacheData[key] = { path: media.path, contentType: media.contentType, savedAt: Date.now() };
  logVerbose(`signal media cached (persistent): ts=${timestamp} path=${media.path}`);
  void persistMediaCache();
}

function getCachedMedia(
  timestamp: number | undefined,
): { path: string; contentType?: string } | null {
  if (!timestamp) {
    return null;
  }
  const entry = mediaCacheData[String(timestamp)];
  if (entry) {
    logVerbose(`signal media cache hit (persistent): ts=${timestamp} path=${entry.path}`);
    return { path: entry.path, contentType: entry.contentType };
  }
  return null;
}

/** Save a buffer to the pre-cache fallback dir when it didn't land in upstream inbound/. */
export async function saveToPrecache(
  buffer: Buffer,
  contentType?: string,
): Promise<{ path: string; contentType?: string }> {
  await fs.mkdir(PRECACHE_DIR, { recursive: true });
  const ext = contentType?.split("/")[1]?.split(";")[0] ?? "bin";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(PRECACHE_DIR, filename);
  await fs.writeFile(filePath, buffer);
  logVerbose(`signal: saved to precache fallback: ${filePath}`);
  return { path: filePath, contentType };
}

// ── Sticker fetch helper ────────────────────────────────────────────────────

async function fetchStickerMedia(params: {
  sticker: SignalSticker;
  senderRecipient: string;
  groupId?: string;
  deps: SignalEnhancementDeps;
}): Promise<{ path: string; contentType?: string } | null> {
  const { sticker, senderRecipient, groupId, deps } = params;
  logVerbose(`sticker data: ${JSON.stringify(sticker)}`);

  if (!sticker.attachment?.id) {
    logVerbose(
      `sticker has no attachment.id, packId=${sticker.packId}, stickerId=${sticker.stickerId}`,
    );
    // Try getSticker RPC (packId + stickerId)
    if (sticker.packId && typeof sticker.stickerId === "number") {
      try {
        return (
          (await deps.fetchSticker?.({
            baseUrl: deps.baseUrl,
            account: deps.account,
            packId: sticker.packId,
            stickerId: sticker.stickerId,
            maxBytes: deps.mediaMaxBytes,
          })) ?? null
        );
      } catch (err) {
        logVerbose(`sticker fetch via packId failed: ${String(err)}`);
      }
    }
    return null;
  }

  try {
    return await deps.fetchAttachment({
      baseUrl: deps.baseUrl,
      account: deps.account,
      attachment: {
        id: sticker.attachment.id,
        contentType: sticker.attachment.contentType ?? sticker.contentType,
        size: sticker.attachment.size,
      } as SignalAttachment,
      sender: senderRecipient,
      groupId,
      maxBytes: deps.mediaMaxBytes,
    });
  } catch (err) {
    logVerbose(`sticker fetch failed: ${String(err)}`);
    return null;
  }
}

// ── Quoted attachment helper ────────────────────────────────────────────────

async function fetchQuotedAttachment(params: {
  quote: SignalQuote;
  senderRecipient: string;
  groupId?: string;
  deps: SignalEnhancementDeps;
}): Promise<{ path: string; contentType?: string } | null> {
  const { quote, senderRecipient, groupId, deps } = params;
  const firstAttachment = quote.attachments?.[0];
  if (!firstAttachment?.id) {
    return null;
  }

  try {
    return await deps.fetchAttachment({
      baseUrl: deps.baseUrl,
      account: deps.account,
      attachment: {
        id: firstAttachment.id,
        contentType: firstAttachment.contentType,
        filename: firstAttachment.filename,
        size: firstAttachment.size,
      } as SignalAttachment,
      sender: quote.author ?? quote.authorNumber ?? senderRecipient,
      groupId,
      maxBytes: deps.mediaMaxBytes,
    });
  } catch (err) {
    logVerbose(`quoted attachment fetch failed: ${String(err)}`);
    return null;
  }
}

// ── requireMention gate ─────────────────────────────────────────────────────

export function checkRequireMention(params: {
  dataMessage: SignalDataMessage;
  isGroup: boolean;
  deps: SignalEnhancementDeps;
}): boolean {
  const { isGroup, deps } = params;
  if (!isGroup || !deps.requireMention) {
    return false;
  }

  const enhanced = asEnhanced(params.dataMessage);
  const mentions = enhanced?.mentions ?? [];
  const botAccount = deps.account?.replace(/^\+/, "") ?? "";
  const botAccountId = deps.accountId ?? "";
  logVerbose(
    `[requireMention] mentions=${JSON.stringify(mentions)}, botAccount=${botAccount}, botAccountId=${botAccountId}`,
  );

  const isMentioned = mentions.some((m) => {
    const mentionNumber = m.number?.replace(/^\+/, "") ?? "";
    if (mentionNumber && mentionNumber === botAccount) {
      return true;
    }
    const mentionUuid = m.uuid ?? "";
    if (mentionUuid && mentionUuid === botAccountId) {
      return true;
    }
    return false;
  });

  if (!isMentioned) {
    logVerbose("Blocked signal group message (requireMention, not mentioned)");
    return true; // blocked
  }
  logVerbose("[requireMention] mention detected, proceeding");
  return false; // not blocked
}

// ── Pre-cache group media ───────────────────────────────────────────────────

export async function preCacheGroupMedia(params: {
  dataMessage: SignalDataMessage;
  senderRecipient: string;
  senderAllowId: string;
  groupId?: string;
  deps: SignalEnhancementDeps;
}): Promise<void> {
  const { senderRecipient, groupId, deps } = params;
  const enhanced = asEnhanced(params.dataMessage);
  if (!enhanced) {
    return;
  }

  const hasAttachmentOrSticker = Boolean(enhanced.attachments?.length || enhanced.sticker);
  if (!hasAttachmentOrSticker || deps.ignoreAttachments) {
    return;
  }

  // Pre-cache normal attachment (fetchAttachment saves to upstream inbound/)
  const firstAtt = enhanced.attachments?.[0];
  if (firstAtt?.id) {
    try {
      const fetched = await deps.fetchAttachment({
        baseUrl: deps.baseUrl,
        account: deps.account,
        attachment: firstAtt,
        sender: senderRecipient,
        groupId,
        maxBytes: deps.mediaMaxBytes,
      });
      if (fetched) {
        cacheMedia(enhanced.timestamp, {
          path: fetched.path,
          contentType: fetched.contentType ?? firstAtt.contentType ?? undefined,
        });
        logVerbose(`signal: pre-cached attachment for group ${groupId}`);
      }
    } catch (err) {
      logVerbose(`signal: pre-cache attachment failed: ${String(err)}`);
    }
  }

  // Pre-cache sticker (fetchSticker saves to upstream inbound/)
  const stk = enhanced.sticker;
  if (stk) {
    try {
      const stickerFetched = await fetchStickerMedia({
        sticker: stk,
        senderRecipient,
        groupId,
        deps,
      });
      if (stickerFetched) {
        cacheMedia(enhanced.timestamp, {
          path: stickerFetched.path,
          contentType: stickerFetched.contentType ?? stk.contentType ?? "image/webp",
        });
        logVerbose(`signal: pre-cached sticker for group ${groupId}`);
      }
    } catch (err) {
      logVerbose(`signal: pre-cache sticker failed: ${String(err)}`);
    }
  }
}

// ── Build enhanced message ──────────────────────────────────────────────────

export async function buildEnhancedMessage(params: {
  dataMessage: SignalDataMessage;
  messageText: string;
  mediaPath?: string;
  mediaType?: string;
  placeholder: string;
  senderRecipient: string;
  groupId?: string;
  deps: SignalEnhancementDeps;
}): Promise<{
  bodyText: string;
  mediaPath?: string;
  mediaType?: string;
  placeholder: string;
}> {
  const { messageText, senderRecipient, groupId, deps } = params;
  let { mediaPath, mediaType, placeholder } = params;
  const enhanced = asEnhanced(params.dataMessage);

  // ── Sticker processing ──
  let stickerInfo = "";
  const sticker = enhanced?.sticker;
  if (sticker && !deps.ignoreAttachments) {
    const stickerEmoji = sticker.emoji ? ` ${sticker.emoji}` : "";
    stickerInfo = `[Sticker${stickerEmoji}] `;
    if (!mediaPath) {
      // Check cache first (from pre-cache), avoiding double fetch
      const cached = getCachedMedia(enhanced?.timestamp);
      if (cached) {
        mediaPath = cached.path;
        mediaType = cached.contentType ?? sticker.contentType ?? "image/webp";
      } else {
        const fetched = await fetchStickerMedia({ sticker, senderRecipient, groupId, deps });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? sticker.contentType ?? "image/webp";
          cacheMedia(enhanced?.timestamp, { path: mediaPath, contentType: mediaType });
        }
      }
    }
  }

  // ── Quote processing ──
  const quote = enhanced?.quote as SignalQuote | null | undefined;
  let quotePrefix = "";
  let quotedMediaPath: string | undefined;
  let quotedMediaType: string | undefined;

  if (quote) {
    const quoteParts: string[] = [];

    // Format quote author
    let quoteAuthor: string;
    const authorId = quote.author ?? quote.authorNumber ?? "";
    if (quote.authorName) {
      quoteAuthor = authorId ? `${quote.authorName} (${authorId})` : quote.authorName;
    } else if (quote.authorNumber) {
      quoteAuthor = quote.author ? `${quote.authorNumber} (${quote.author})` : quote.authorNumber;
    } else if (quote.author) {
      quoteAuthor = quote.author;
    } else {
      quoteAuthor = "對方";
    }

    // Format quote time
    let quoteTime = "";
    if (typeof quote.id === "number" && quote.id > 0) {
      const date = new Date(quote.id);
      quoteTime = ` ${date.toLocaleDateString("zh-TW")} ${date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`;
    }

    if (quote.text?.trim()) {
      quoteParts.push(quote.text.trim());
    }

    // Quoted attachments
    if (quote.attachments?.length && !deps.ignoreAttachments) {
      const firstQuotedAtt = quote.attachments[0];
      const contentType = firstQuotedAtt?.contentType ?? "";
      const isSticker = contentType === "image/webp" || firstQuotedAtt?.filename?.endsWith(".webp");

      quoteParts.push(
        isSticker ? "<quoted-sticker>" : `<quoted-${contentType.split("/")[0] || "file"}>`,
      );

      // Fetch quoted media if we don't already have media
      if (!mediaPath && !quotedMediaPath) {
        const quoteTimestamp = typeof quote.id === "number" ? quote.id : undefined;
        const cached = getCachedMedia(quoteTimestamp);
        if (cached) {
          quotedMediaPath = cached.path;
          quotedMediaType = cached.contentType ?? contentType ?? undefined;
        } else {
          const fetched = await fetchQuotedAttachment({ quote, senderRecipient, groupId, deps });
          if (fetched) {
            quotedMediaPath = fetched.path;
            quotedMediaType = fetched.contentType ?? contentType ?? undefined;
          }
        }
      }
    }

    if (quoteParts.length > 0) {
      quotePrefix = `[引用 ${quoteAuthor}${quoteTime}: ${quoteParts.join(" ")}]\n`;
    }
  }

  // ── Rebuild placeholder with sticker/quoted media awareness ──
  const effectiveMediaType = mediaType ?? quotedMediaType;
  const kind = mediaKindFromMime(effectiveMediaType ?? undefined);
  if (kind) {
    placeholder = `<media:${kind}>`;
  } else if (enhanced?.attachments?.length || sticker) {
    placeholder = "<media:attachment>";
  }

  // Use quoted media if no direct media
  if (!mediaPath && quotedMediaPath) {
    mediaPath = quotedMediaPath;
    mediaType = quotedMediaType;
  }

  // ── Assemble body text ──
  // Strip U+FFFC (Object Replacement Character) used by Signal for @mention placeholders
  const cleanedMessageText = messageText?.replace(/\uFFFC/g, "").trim() || "";
  const fallbackQuoteText = !quotePrefix && quote?.text?.trim() ? quote.text.trim() : "";
  const bodyText =
    quotePrefix + stickerInfo + (cleanedMessageText || placeholder || fallbackQuoteText);

  return { bodyText, mediaPath, mediaType, placeholder };
}

/**
 * Strip U+FFFC from text for command detection.
 * Signal uses this character as a placeholder for @mention rendering.
 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/\uFFFC/g, "").trim();
}
