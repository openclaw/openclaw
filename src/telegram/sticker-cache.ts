import fs from "node:fs/promises";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { getTgStateFromDb, setTgStateInDb } from "../infra/state-db/channel-tg-state-sqlite.js";
import { AUTO_IMAGE_KEY_PROVIDERS, DEFAULT_IMAGE_MODELS } from "../media-understanding/defaults.js";
import { resolveAutoImageModel } from "../media-understanding/runner.js";

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

const TG_STICKER_ACCOUNT = "global";
const TG_STICKER_KEY = "sticker_cache";

type StickerCacheData = Record<string, CachedSticker>;

function loadCache(): StickerCacheData {
  return getTgStateFromDb<StickerCacheData>(TG_STICKER_ACCOUNT, TG_STICKER_KEY) ?? {};
}

function saveCache(stickers: StickerCacheData): void {
  setTgStateInDb(TG_STICKER_ACCOUNT, TG_STICKER_KEY, stickers);
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  const stickers = loadCache();
  return stickers[fileUniqueId] ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  const stickers = loadCache();
  stickers[sticker.fileUniqueId] = sticker;
  saveCache(stickers);
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const stickers = loadCache();
  const queryLower = query.toLowerCase();
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(stickers)) {
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
  return Object.values(loadCache());
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const stickers = Object.values(loadCache());
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
let imageRuntimePromise: Promise<
  typeof import("../media-understanding/providers/image-runtime.js")
> | null = null;

function loadImageRuntime() {
  imageRuntimePromise ??= import("../media-understanding/providers/image-runtime.js");
  return imageRuntimePromise;
}

export interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
}

/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
export async function describeStickerImage(params: DescribeStickerParams): Promise<string | null> {
  const { imagePath, cfg, agentDir, agentId } = params;

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

  const selectCatalogModel = (provider: string) => {
    const entries = catalog.filter(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() && modelSupportsVision(entry),
    );
    if (entries.length === 0) {
      return undefined;
    }
    const defaultId = DEFAULT_IMAGE_MODELS[provider];
    const preferred = entries.find((entry) => entry.id === defaultId);
    return preferred ?? entries[0];
  };

  let resolved = null as { provider: string; model?: string } | null;
  if (
    activeModel &&
    AUTO_IMAGE_KEY_PROVIDERS.includes(
      activeModel.provider as (typeof AUTO_IMAGE_KEY_PROVIDERS)[number],
    ) &&
    (await hasProviderKey(activeModel.provider))
  ) {
    resolved = activeModel;
  }

  if (!resolved) {
    for (const provider of AUTO_IMAGE_KEY_PROVIDERS) {
      if (!(await hasProviderKey(provider))) {
        continue;
      }
      const entry = selectCatalogModel(provider);
      if (entry) {
        resolved = { provider, model: entry.id };
        break;
      }
    }
  }

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
    // Lazy import to avoid circular dependency
    const { describeImageWithModel } = await loadImageRuntime();
    const result = await describeImageWithModel({
      buffer,
      fileName: "sticker.webp",
      mime: "image/webp",
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
