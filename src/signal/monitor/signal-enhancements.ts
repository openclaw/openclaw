/**
 * Signal Enhancements Module
 *
 * All Signal-specific enhancements (sticker support, quote/reply messages,
 * requireMention, persistent media cache, pre-cache, agent media cache) live here.
 * Upstream files only need minimal hook calls into this module.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEventHandlerDeps,
} from "./event-handler.types.js";
import { logVerbose } from "../../globals.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
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

// ── Agent media cache (persistent, per-agent, LRU eviction) ─────────────────
//
// Files: ~/.openclaw/media/inbound/signal/{agentId}/{uuid}.{ext}
// Index: ~/.openclaw/media/inbound/signal/{agentId}/cache-index.json
// Config: ~/.openclaw/media/inbound/signal/cache-config.json
//   { "defaults": { "maxSizeGB": 5 }, "agents": { "<id>": { "maxSizeGB": 2 } } }

const AGENT_CACHE_BASE = path.join(resolveConfigDir(), "media", "inbound", "signal");
const CACHE_CONFIG_PATH = path.join(AGENT_CACHE_BASE, "cache-config.json");
const CACHE_INDEX_FILE = "cache-index.json";
const DEFAULT_MAX_SIZE_GB = 5;

type CacheConfig = {
  defaults?: { maxSizeGB?: number };
  agents?: Record<string, { maxSizeGB?: number }>;
};

type AgentCacheEntry = {
  id: string;
  path: string;
  contentType?: string;
  size: number;
  savedAt: number;
  channel: string;
  groupId?: string;
  senderId?: string;
  timestamp?: number;
};

type AgentCacheIndex = {
  entries: AgentCacheEntry[];
  totalSize: number;
};

// In-memory caches
const cacheIndexMap = new Map<string, AgentCacheIndex>();
let cacheConfig: CacheConfig | null = null;

function resolveAgentCacheDir(agentId: string): string {
  return path.join(AGENT_CACHE_BASE, agentId);
}

function resolveAgentCacheIndexPath(agentId: string): string {
  return path.join(resolveAgentCacheDir(agentId), CACHE_INDEX_FILE);
}

async function loadCacheConfig(): Promise<CacheConfig> {
  if (cacheConfig) {
    return cacheConfig;
  }
  try {
    const content = await fs.readFile(CACHE_CONFIG_PATH, "utf-8");
    cacheConfig = JSON.parse(content) as CacheConfig;
  } catch {
    cacheConfig = {};
  }
  return cacheConfig;
}

function getMaxSizeBytes(config: CacheConfig, agentId: string): number {
  const agentGB = config.agents?.[agentId]?.maxSizeGB;
  const defaultGB = config.defaults?.maxSizeGB ?? DEFAULT_MAX_SIZE_GB;
  return (agentGB ?? defaultGB) * 1024 * 1024 * 1024;
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

async function loadAgentCacheIndex(agentId: string): Promise<AgentCacheIndex> {
  const cached = cacheIndexMap.get(agentId);
  if (cached) {
    return cached;
  }
  const indexPath = resolveAgentCacheIndexPath(agentId);
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(content) as AgentCacheIndex;
    cacheIndexMap.set(agentId, index);
    logVerbose(
      `agent media cache loaded: agentId=${agentId} entries=${index.entries.length} size=${formatBytes(index.totalSize)}`,
    );
    return index;
  } catch {
    const emptyIndex: AgentCacheIndex = { entries: [], totalSize: 0 };
    cacheIndexMap.set(agentId, emptyIndex);
    return emptyIndex;
  }
}

async function saveAgentCacheIndex(agentId: string, index: AgentCacheIndex): Promise<void> {
  const cacheDir = resolveAgentCacheDir(agentId);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(resolveAgentCacheIndexPath(agentId), JSON.stringify(index, null, 2));
}

/** LRU eviction: delete oldest entries until totalSize <= targetSize */
async function evictOldEntries(
  agentId: string,
  index: AgentCacheIndex,
  targetSize: number,
): Promise<void> {
  const sorted = [...index.entries].toSorted((a, b) => a.savedAt - b.savedAt);
  while (index.totalSize > targetSize && sorted.length > 0) {
    const oldest = sorted.shift();
    if (!oldest) {
      break;
    }
    try {
      await fs.unlink(oldest.path);
      logVerbose(`agent media cache evict: deleted ${oldest.path} (${formatBytes(oldest.size)})`);
    } catch {
      // File may already be deleted
    }
    index.totalSize -= oldest.size;
    const idx = index.entries.findIndex((e) => e.id === oldest.id);
    if (idx >= 0) {
      index.entries.splice(idx, 1);
    }
  }
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

/** Save media buffer to agent cache with LRU eviction. */
async function saveToAgentCache(params: {
  agentId: string;
  buffer: Buffer;
  contentType?: string;
  channel: string;
  groupId?: string;
  senderId?: string;
  timestamp?: number;
  originalFilename?: string;
}): Promise<{ path: string; contentType?: string } | null> {
  const { agentId, buffer, contentType, channel, groupId, senderId, timestamp, originalFilename } =
    params;
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const config = await loadCacheConfig();
  const maxSizeBytes = getMaxSizeBytes(config, agentId);
  const index = await loadAgentCacheIndex(agentId);
  const cacheDir = resolveAgentCacheDir(agentId);
  await fs.mkdir(cacheDir, { recursive: true });

  // Evict if adding this file would exceed limit
  if (index.totalSize + buffer.length > maxSizeBytes) {
    const target = maxSizeBytes - buffer.length - 100 * 1024 * 1024; // 100MB headroom
    await evictOldEntries(agentId, index, Math.max(0, target));
  }

  const id = crypto.randomUUID();
  const ext = contentType?.split("/")[1]?.split(";")[0] ?? "bin";
  const filename = originalFilename
    ? `${sanitizeFilename(originalFilename)}---${id}.${ext}`
    : `${id}.${ext}`;
  const filePath = path.join(cacheDir, filename);

  try {
    await fs.writeFile(filePath, buffer);
    const entry: AgentCacheEntry = {
      id,
      path: filePath,
      contentType,
      size: buffer.length,
      savedAt: Date.now(),
      channel,
      groupId,
      senderId,
      timestamp,
    };
    index.entries.push(entry);
    index.totalSize += buffer.length;
    await saveAgentCacheIndex(agentId, index);
    logVerbose(
      `agent media cache saved: agentId=${agentId} path=${filePath} size=${formatBytes(buffer.length)}`,
    );
    return { path: filePath, contentType };
  } catch (err) {
    logVerbose(`agent media cache save failed: ${String(err)}`);
    return null;
  }
}

// ── Persistent media lookup cache (timestamp → path index) ──────────────────

type MediaCacheEntry = { path: string; contentType?: string; savedAt: number };
type MediaCacheData = Record<string, MediaCacheEntry>;

const MEDIA_CACHE_FILE = path.join(resolveConfigDir(), "media", "signal-media-cache.json");
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
  const { senderRecipient, senderAllowId, groupId, deps } = params;
  const enhanced = asEnhanced(params.dataMessage);
  if (!enhanced) {
    return;
  }

  const hasAttachmentOrSticker = Boolean(enhanced.attachments?.length || enhanced.sticker);
  if (!hasAttachmentOrSticker || deps.ignoreAttachments) {
    return;
  }

  const routeForCache = resolveAgentRoute({
    cfg: deps.cfg,
    channel: "signal",
    accountId: deps.accountId,
    peer: { kind: "group", id: groupId ?? "unknown" },
  });

  // Cache normal attachment
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
        const buffer = await fs.readFile(fetched.path);
        await saveToAgentCache({
          agentId: routeForCache.agentId,
          buffer,
          contentType: fetched.contentType ?? firstAtt.contentType ?? undefined,
          channel: "signal",
          groupId,
          senderId: senderAllowId,
          timestamp: enhanced.timestamp,
          originalFilename: firstAtt.filename ?? undefined,
        });
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

  // Cache sticker
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
        const buffer = await fs.readFile(stickerFetched.path);
        await saveToAgentCache({
          agentId: routeForCache.agentId,
          buffer,
          contentType: stickerFetched.contentType ?? stk.contentType ?? "image/webp",
          channel: "signal",
          groupId,
          senderId: senderAllowId,
          timestamp: enhanced.timestamp,
        });
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
