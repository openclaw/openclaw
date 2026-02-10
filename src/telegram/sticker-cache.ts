import type { Sticker } from "@grammyjs/types";
import type { Bot } from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { STATE_DIR } from "../config/paths.js";
import { logVerbose } from "../globals.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveAutoImageModel } from "../media-understanding/runner.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";

const CACHE_FILE = path.join(STATE_DIR, "telegram", "sticker-cache.json");
const CACHE_VERSION = 1;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

/** Metadata for an indexed sticker set. */
export interface IndexedStickerSet {
  indexedAt: string;
  stickerCount: number;
  title: string;
}

interface StickerCache {
  version: number;
  stickers: Record<string, CachedSticker>;
  /** Tracks which sticker sets have been fully indexed. */
  indexedSets?: Record<string, IndexedStickerSet>;
}

/** Default cache TTL in days. */
const DEFAULT_CACHE_TTL_DAYS = 90;
/** Default max cache entries. */
const DEFAULT_CACHE_MAX_ENTRIES = 5000;

/** Eviction config overrides (set via `configureCacheEviction`). */
let evictionConfig: { ttlDays?: number; maxEntries?: number } = {};

/**
 * Set cache eviction parameters. Call at startup or when config changes.
 */
export function configureCacheEviction(opts: { ttlDays?: number; maxEntries?: number }): void {
  evictionConfig = opts;
}

function loadCache(): StickerCache {
  const data = loadJsonFile(CACHE_FILE);
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data as StickerCache;
  if (cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}

function saveCache(cache: StickerCache): void {
  saveJsonFile(CACHE_FILE, cache);
}

/**
 * Evict stale cache entries based on TTL and max size.
 * Returns the number of entries removed.
 */
export function evictStaleEntries(opts?: { ttlDays?: number; maxEntries?: number }): number {
  const cache = loadCache();
  const ttlDays = opts?.ttlDays ?? evictionConfig.ttlDays ?? DEFAULT_CACHE_TTL_DAYS;
  const maxEntries = opts?.maxEntries ?? evictionConfig.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  // Phase 1: Remove entries older than TTL
  for (const [key, sticker] of Object.entries(cache.stickers)) {
    const cachedTime = new Date(sticker.cachedAt).getTime();
    if (cachedTime < cutoff) {
      delete cache.stickers[key];
      removed++;
    }
  }

  // Phase 2: If still over maxEntries, remove oldest first (LRU by cachedAt)
  const entries = Object.entries(cache.stickers);
  if (entries.length > maxEntries) {
    const sorted = entries.toSorted(
      ([, a], [, b]) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
    );
    const toRemove = sorted.slice(0, entries.length - maxEntries);
    for (const [key] of toRemove) {
      delete cache.stickers[key];
      removed++;
    }
  }

  if (removed > 0) {
    saveCache(cache);
    logVerbose(`telegram: evicted ${removed} stale sticker cache entries`);
  }
  return removed;
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  const cache = loadCache();
  return cache.stickers[fileUniqueId] ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  const cache = loadCache();
  cache.stickers[sticker.fileUniqueId] = sticker;
  saveCache(cache);
}

/**
 * Check if a sticker set has been indexed.
 */
export function isSetIndexed(setName: string): boolean {
  const cache = loadCache();
  return Boolean(cache.indexedSets?.[setName]);
}

/**
 * Mark a sticker set as indexed.
 */
export function markSetIndexed(setName: string, info: IndexedStickerSet): void {
  const cache = loadCache();
  if (!cache.indexedSets) {
    cache.indexedSets = {};
  }
  cache.indexedSets[setName] = info;
  saveCache(cache);
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = loadCache();
  const queryLower = query.toLowerCase();
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(cache.stickers)) {
    let score = 0;
    const descLower = sticker.description.toLowerCase();

    // Exact substring match in description
    if (descLower.includes(queryLower)) {
      score += 10;
    }

    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    // Emoji match
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

    // Set name match
    if (sticker.setName?.toLowerCase().includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ sticker, score });
    }
  }

  return results
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.sticker);
}

/**
 * Get all cached stickers (for debugging/listing).
 */
export function getAllCachedStickers(): CachedSticker[] {
  const cache = loadCache();
  return Object.values(cache.stickers);
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const cache = loadCache();
  const stickers = Object.values(cache.stickers);
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}

const STICKER_DESCRIPTION_PROMPT =
  "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";
export interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  /** MIME type of the image (e.g. "image/webp", "image/jpeg"). Defaults to "image/webp". */
  contentType?: string;
  /** Explicit vision model override from config (provider/model). */
  visionModel?: string;
}

/**
 * Describe a sticker image using vision API.
 * Resolution order:
 *   1. Explicit `stickerVisionModel` from telegram config
 *   2. Agent's default model (if it supports vision)
 *   3. Any vision-capable model in the catalog with an available API key
 *   4. Media-understanding auto-resolver fallback
 * Returns null if no vision provider is available.
 */
export async function describeStickerImage(params: DescribeStickerParams): Promise<string | null> {
  const { imagePath, cfg, agentDir, agentId, visionModel } = params;

  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  let activeModel = undefined as { provider: string; model: string } | undefined;
  let catalog: ModelCatalogEntry[] = [];
  try {
    catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    const supportsVision = modelSupportsVision(entry);
    if (supportsVision) {
      activeModel = { provider: defaultModel.provider, model: defaultModel.model };
    }
  } catch {
    // Ignore catalog failures; fall back to auto selection.
  }

  const hasProviderKey = async (provider: string) => {
    try {
      await resolveApiKeyForProvider({ provider, cfg, agentDir });
      return true;
    } catch {
      return false;
    }
  };

  let resolved = null as { provider: string; model?: string } | null;

  // 1. Explicit stickerVisionModel from config (highest priority).
  if (visionModel) {
    const slashIdx = visionModel.indexOf("/");
    if (slashIdx > 0) {
      const provider = visionModel.slice(0, slashIdx);
      const model = visionModel.slice(slashIdx + 1);
      if (await hasProviderKey(provider)) {
        resolved = { provider, model };
      } else {
        logVerbose(
          `telegram: stickerVisionModel provider "${provider}" has no API key, falling back`,
        );
      }
    }
  }

  // 2. If the agent's default model supports vision, use it directly.
  if (!resolved && activeModel && (await hasProviderKey(activeModel.provider))) {
    resolved = activeModel;
  }

  // 3. Scan catalog for any vision-capable model with an available API key.
  //    No hardcoded provider list — uses whatever is configured.
  if (!resolved) {
    const visionEntries = catalog.filter((entry) => modelSupportsVision(entry));
    const seenProviders = new Set<string>();
    for (const entry of visionEntries) {
      const provider = entry.provider;
      if (seenProviders.has(provider)) {
        continue;
      }
      seenProviders.add(provider);
      if (await hasProviderKey(provider)) {
        resolved = { provider, model: entry.id };
        break;
      }
    }
  }

  // 4. Last resort: use the media-understanding auto-resolver.
  if (!resolved) {
    resolved = await resolveAutoImageModel({
      cfg,
      agentDir,
      activeModel,
    });
  }

  if (!resolved?.model) {
    logVerbose("telegram: no vision provider available for sticker description");
    return null;
  }

  const { provider, model } = resolved;
  logVerbose(`telegram: describing sticker with ${provider}/${model}`);

  try {
    const buffer = await fs.readFile(imagePath);
    const mime = params.contentType ?? "image/webp";
    const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "webp";
    // Dynamic import to avoid circular dependency
    const { describeImageWithModel } = await import("../media-understanding/providers/image.js");
    const result = await describeImageWithModel({
      buffer,
      fileName: `sticker.${ext}`,
      mime,
      prompt: STICKER_DESCRIPTION_PROMPT,
      cfg,
      agentDir: agentDir ?? "",
      provider,
      model,
      maxTokens: 150,
      timeoutMs: 30000,
    });
    return result.text;
  } catch (err) {
    logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
    return null;
  }
}

// --- Sticker Set Indexing ---

const SET_INDEX_BATCH_SIZE = 5;
const SET_INDEX_BATCH_DELAY_MS = 500;

export interface IndexStickerSetParams {
  setName: string;
  bot: Bot;
  token: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  /** Max stickers to describe per set. Default: 20 */
  limit?: number;
  fetchImpl?: typeof fetch;
  /** Explicit vision model override from config (provider/model). */
  visionModel?: string;
}

/**
 * Download a sticker thumbnail via the Telegram Bot API.
 * Returns the saved file path and contentType, or null.
 */
async function downloadThumbnailForSticker(
  sticker: Sticker,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ path: string; contentType?: string } | null> {
  const thumb = sticker.thumbnail;
  if (!thumb?.file_id) {
    return null;
  }
  try {
    const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${thumb.file_id}`;
    const res = await fetchImpl(getFileUrl);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = data.result?.file_path;
    if (!filePath) {
      return null;
    }
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fetched = await fetchRemoteMedia({ url, fetchImpl, filePathHint: filePath });
    return await saveMediaBuffer(
      fetched.buffer,
      fetched.contentType,
      "inbound",
      5 * 1024 * 1024,
      fetched.fileName ?? filePath,
    );
  } catch {
    return null;
  }
}

/**
 * Index an entire sticker set: fetch all stickers, download thumbnails,
 * describe via vision, and cache. Skips already-cached stickers.
 * Returns the number of newly cached stickers.
 */
export async function indexStickerSet(params: IndexStickerSetParams): Promise<number> {
  const { setName, bot, token, cfg, agentDir, agentId, fetchImpl } = params;
  const limit = params.limit ?? 20;

  if (isSetIndexed(setName)) {
    logVerbose(`telegram: sticker set "${setName}" already indexed, skipping`);
    return 0;
  }

  let stickerSet: { name: string; title: string; stickers: Sticker[] };
  try {
    stickerSet = await bot.api.getStickerSet(setName);
  } catch (err) {
    logVerbose(`telegram: failed to get sticker set "${setName}": ${String(err)}`);
    return 0;
  }

  const stickersToIndex = stickerSet.stickers.filter((s) => {
    // Skip already cached
    return !getCachedSticker(s.file_unique_id);
  });

  const toProcess = stickersToIndex.slice(0, limit);
  let newlyCached = 0;
  const resolvedFetch = fetchImpl ?? globalThis.fetch;

  // Process in batches
  for (let i = 0; i < toProcess.length; i += SET_INDEX_BATCH_SIZE) {
    const batch = toProcess.slice(i, i + SET_INDEX_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (sticker) => {
        const thumb = await downloadThumbnailForSticker(sticker, token, resolvedFetch);
        if (!thumb) {
          return null;
        }
        const description = await describeStickerImage({
          imagePath: thumb.path,
          cfg,
          agentDir,
          agentId,
          contentType: thumb.contentType,
          visionModel: params.visionModel,
        });
        if (!description) {
          return null;
        }
        cacheSticker({
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
          emoji: sticker.emoji ?? undefined,
          setName,
          description,
          cachedAt: new Date().toISOString(),
        });
        return true;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        newlyCached++;
      }
    }

    // Delay between batches (skip after last batch)
    if (i + SET_INDEX_BATCH_SIZE < toProcess.length) {
      await new Promise((resolve) => setTimeout(resolve, SET_INDEX_BATCH_DELAY_MS));
    }
  }

  markSetIndexed(setName, {
    indexedAt: new Date().toISOString(),
    stickerCount: stickerSet.stickers.length,
    title: stickerSet.title,
  });

  logVerbose(
    `telegram: indexed sticker set "${setName}" (${stickerSet.title}): ${newlyCached} new of ${stickerSet.stickers.length} total`,
  );

  return newlyCached;
}
