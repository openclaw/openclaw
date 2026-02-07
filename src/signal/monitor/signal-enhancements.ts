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

// ── Pre-cache: per-group persistent media index + LRU ────────────────────────
//
// fetchAttachment/fetchSticker both call saveMediaBuffer → ~/.openclaw/media/inbound/
// Files there are NOT TTL-cleaned (cleanup only targets ~/.openclaw/media/ root).
//
// Directory layout:
//   ~/.openclaw/media/inbound/signal_precache/
//   ├── group-precache-config.json                  ← per-group GB quota
//   ├── {group-id}/
//   │   ├── signal-media-precache.json              ← timestamp→path index
//   │   └── {timestamp}-{rand}.{ext}               ← fallback files
//   └── ...

const PRECACHE_DIR = path.join(resolveConfigDir(), "media", "inbound", "signal_precache");
const PRECACHE_CONFIG_PATH = path.join(PRECACHE_DIR, "group-precache-config.json");
const DEFAULT_MAX_SIZE_GB = 5;

type PrecacheConfig = {
  defaults?: { maxSizeGB?: number };
  groups?: Record<string, { maxSizeGB?: number }>;
};

type MediaCacheEntry = {
  path: string;
  contentType?: string;
  savedAt: number;
  size: number;
};

type GroupCacheIndex = {
  entries: Record<string, MediaCacheEntry>; // keyed by timestamp string
  totalSize: number;
};

// In-memory state
const groupCaches = new Map<string, GroupCacheIndex>();
const savePendingGroups = new Set<string>();
let precacheConfig: PrecacheConfig | null = null;

function resolveGroupDir(groupId: string): string {
  return path.join(PRECACHE_DIR, groupId);
}

function resolveGroupIndexPath(groupId: string): string {
  return path.join(resolveGroupDir(groupId), "signal-media-precache.json");
}

async function loadPrecacheConfig(): Promise<PrecacheConfig> {
  if (precacheConfig) {
    return precacheConfig;
  }
  try {
    const content = await fs.readFile(PRECACHE_CONFIG_PATH, "utf-8");
    precacheConfig = JSON.parse(content) as PrecacheConfig;
  } catch {
    precacheConfig = {};
  }
  return precacheConfig;
}

function getGroupMaxBytes(config: PrecacheConfig, groupId: string): number {
  const groupGB = config.groups?.[groupId]?.maxSizeGB;
  const defaultGB = config.defaults?.maxSizeGB ?? DEFAULT_MAX_SIZE_GB;
  return (groupGB ?? defaultGB) * 1024 * 1024 * 1024;
}

/** Lazy-load a group's cache index from disk. */
async function loadGroupCache(groupId: string): Promise<GroupCacheIndex> {
  const existing = groupCaches.get(groupId);
  if (existing) {
    return existing;
  }
  const indexPath = resolveGroupIndexPath(groupId);
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(content) as GroupCacheIndex;
    groupCaches.set(groupId, index);
    const count = Object.keys(index.entries).length;
    logVerbose(
      `signal precache loaded: group=${groupId} entries=${count} size=${formatBytes(index.totalSize)}`,
    );
    return index;
  } catch {
    const empty: GroupCacheIndex = { entries: {}, totalSize: 0 };
    groupCaches.set(groupId, empty);
    return empty;
  }
}

async function persistGroupCache(groupId: string): Promise<void> {
  if (savePendingGroups.has(groupId)) {
    return; // debounce per group
  }
  savePendingGroups.add(groupId);
  try {
    const dir = resolveGroupDir(groupId);
    await fs.mkdir(dir, { recursive: true });
    const index = groupCaches.get(groupId);
    if (index) {
      await fs.writeFile(resolveGroupIndexPath(groupId), JSON.stringify(index, null, 2));
    }
  } catch (err) {
    logVerbose(`signal precache save failed (group=${groupId}): ${String(err)}`);
  } finally {
    savePendingGroups.delete(groupId);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/** LRU eviction: delete oldest entries until totalSize <= targetSize. */
async function evictOldEntries(index: GroupCacheIndex, targetSize: number): Promise<void> {
  const sorted = Object.entries(index.entries).toSorted(([, a], [, b]) => a.savedAt - b.savedAt);
  for (const [key, entry] of sorted) {
    if (index.totalSize <= targetSize) {
      break;
    }
    try {
      await fs.unlink(entry.path);
      logVerbose(`signal precache evict: deleted ${entry.path} (${formatBytes(entry.size)})`);
    } catch {
      // File may already be deleted
    }
    index.totalSize -= entry.size;
    delete index.entries[key];
  }
}

/** Startup hook — kept as no-op since group caches are lazy-loaded. */
export async function loadSignalMediaCache(): Promise<void> {
  // Groups are loaded lazily on first access; nothing to do at startup.
}

/** Record a media file in a group's precache index, with LRU eviction. */
async function cacheMedia(
  groupId: string | undefined,
  timestamp: number | undefined,
  media: { path: string; contentType?: string; size?: number },
): Promise<void> {
  if (!groupId || !timestamp || !media.path) {
    return;
  }
  const index = await loadGroupCache(groupId);
  const key = String(timestamp);

  // Estimate file size if not provided
  let fileSize = media.size ?? 0;
  if (!fileSize) {
    try {
      const stat = await fs.stat(media.path);
      fileSize = stat.size;
    } catch {
      fileSize = 0;
    }
  }

  // LRU eviction if adding this entry exceeds quota
  const config = await loadPrecacheConfig();
  const maxBytes = getGroupMaxBytes(config, groupId);
  if (index.totalSize + fileSize > maxBytes) {
    await evictOldEntries(index, maxBytes - fileSize);
  }

  index.entries[key] = {
    path: media.path,
    contentType: media.contentType,
    savedAt: Date.now(),
    size: fileSize,
  };
  index.totalSize += fileSize;
  logVerbose(
    `signal precache: group=${groupId} ts=${timestamp} path=${media.path} size=${formatBytes(fileSize)}`,
  );
  void persistGroupCache(groupId);
}

/** Look up cached media by timestamp, searching the given group first. */
async function getCachedMedia(
  groupId: string | undefined,
  timestamp: number | undefined,
): Promise<{ path: string; contentType?: string } | null> {
  if (!timestamp) {
    return null;
  }
  const key = String(timestamp);

  // Search specific group first
  if (groupId) {
    const index = await loadGroupCache(groupId);
    const entry = index.entries[key];
    if (entry) {
      logVerbose(`signal precache hit: group=${groupId} ts=${timestamp} path=${entry.path}`);
      return { path: entry.path, contentType: entry.contentType };
    }
  }

  // Fallback: search all loaded groups (for DM quoting a group message)
  for (const [gid, index] of groupCaches) {
    if (gid === groupId) {
      continue;
    }
    const entry = index.entries[key];
    if (entry) {
      logVerbose(`signal precache hit (cross-group ${gid}): ts=${timestamp} path=${entry.path}`);
      return { path: entry.path, contentType: entry.contentType };
    }
  }
  return null;
}

/** Save a buffer to the group's pre-cache fallback dir. */
export async function saveToPrecache(
  groupId: string | undefined,
  buffer: Buffer,
  contentType?: string,
): Promise<{ path: string; contentType?: string }> {
  const dir = groupId ? resolveGroupDir(groupId) : PRECACHE_DIR;
  await fs.mkdir(dir, { recursive: true });
  const ext = contentType?.split("/")[1]?.split(";")[0] ?? "bin";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(dir, filename);
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
        await cacheMedia(groupId, enhanced.timestamp, {
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
        await cacheMedia(groupId, enhanced.timestamp, {
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
      const cached = await getCachedMedia(groupId, enhanced?.timestamp);
      if (cached) {
        mediaPath = cached.path;
        mediaType = cached.contentType ?? sticker.contentType ?? "image/webp";
      } else {
        const fetched = await fetchStickerMedia({ sticker, senderRecipient, groupId, deps });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? sticker.contentType ?? "image/webp";
          await cacheMedia(groupId, enhanced?.timestamp, {
            path: mediaPath,
            contentType: mediaType,
          });
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
        const cached = await getCachedMedia(groupId, quoteTimestamp);
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
