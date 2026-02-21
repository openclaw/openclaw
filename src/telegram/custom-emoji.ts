import type { MessageEntity, Sticker } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";
import { cacheSticker, describeStickerImage, getCachedSticker } from "./sticker-cache.js";

/**
 * Resolved description for a custom emoji entity.
 */
export interface CustomEmojiAnnotation {
  /** Offset in the original text. */
  offset: number;
  /** Length of the entity in the original text. */
  length: number;
  /** Vision-based description of the custom emoji. */
  description: string;
  /** Custom emoji ID. */
  customEmojiId: string;
}

export interface ResolveCustomEmojiParams {
  text: string;
  entities: MessageEntity[];
  bot: Bot;
  token: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  fetchImpl?: typeof fetch;
  /** Explicit vision model override from config (provider/model). */
  visionModel?: string;
}

/**
 * Extract custom emoji entities from a message, describe them via vision
 * (using cache when available), and return annotated text with descriptions.
 * Returns the original text unchanged if no custom emoji are found or
 * the feature is disabled.
 */
export async function resolveCustomEmojiAnnotations(
  params: ResolveCustomEmojiParams,
): Promise<{ annotatedText: string; annotations: CustomEmojiAnnotation[] }> {
  const { text, entities, bot, token, cfg, agentDir, agentId, fetchImpl, visionModel } = params;

  // Filter custom_emoji entities
  const customEmojiEntities = entities.filter(
    (e): e is MessageEntity & { type: "custom_emoji"; custom_emoji_id: string } =>
      e.type === "custom_emoji" && "custom_emoji_id" in e,
  );

  if (customEmojiEntities.length === 0) {
    return { annotatedText: text, annotations: [] };
  }

  // Deduplicate emoji IDs
  const uniqueIds = [...new Set(customEmojiEntities.map((e) => e.custom_emoji_id))];

  // Check cache first
  const descriptions = new Map<string, string>();
  const uncachedIds: string[] = [];

  for (const id of uniqueIds) {
    // Custom emoji are cached with a "ce:" prefix to avoid collisions with sticker file_unique_ids
    const cached = getCachedSticker(`ce:${id}`);
    if (cached) {
      descriptions.set(id, cached.description);
    } else {
      uncachedIds.push(id);
    }
  }

  // Fetch uncached custom emoji
  if (uncachedIds.length > 0) {
    try {
      const stickers = await bot.api.getCustomEmojiStickers(uncachedIds);
      const resolvedFetch = fetchImpl ?? globalThis.fetch;
      if (resolvedFetch) {
        await Promise.allSettled(
          stickers.map(async (sticker: Sticker) => {
            const emojiId = sticker.custom_emoji_id;
            if (!emojiId) {
              return;
            }
            const desc = await describeCustomEmojiSticker({
              sticker,
              token,
              cfg,
              agentDir,
              agentId,
              fetchImpl: resolvedFetch,
              visionModel,
            });
            if (desc) {
              descriptions.set(emojiId, desc);
              // Cache with "ce:" prefix
              cacheSticker({
                fileId: sticker.file_id,
                fileUniqueId: `ce:${emojiId}`,
                emoji: sticker.emoji ?? undefined,
                setName: sticker.set_name ?? undefined,
                description: desc,
                cachedAt: new Date().toISOString(),
              });
            }
          }),
        );
      }
    } catch (err) {
      logVerbose(`telegram: failed to resolve custom emoji: ${String(err)}`);
    }
  }

  // Build annotations
  const annotations: CustomEmojiAnnotation[] = [];
  for (const entity of customEmojiEntities) {
    const desc = descriptions.get(entity.custom_emoji_id);
    if (desc) {
      annotations.push({
        offset: entity.offset,
        length: entity.length,
        description: desc,
        customEmojiId: entity.custom_emoji_id,
      });
    }
  }

  // Annotate text: append descriptions inline after each custom emoji
  // Process from end to start to preserve offsets
  let annotatedText = text;
  const sortedAnnotations = [...annotations].toSorted((a, b) => b.offset - a.offset);
  for (const ann of sortedAnnotations) {
    const endIdx = ann.offset + ann.length;
    annotatedText =
      annotatedText.slice(0, endIdx) + `[emoji: ${ann.description}]` + annotatedText.slice(endIdx);
  }

  return { annotatedText, annotations };
}

async function describeCustomEmojiSticker(params: {
  sticker: Sticker;
  token: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  fetchImpl: typeof fetch;
  visionModel?: string;
}): Promise<string | null> {
  const { sticker, token, cfg, agentDir, agentId, fetchImpl, visionModel } = params;
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
    const saved = await saveMediaBuffer(
      fetched.buffer,
      fetched.contentType,
      "inbound",
      5 * 1024 * 1024,
      fetched.fileName ?? filePath,
    );

    return await describeStickerImage({
      imagePath: saved.path,
      cfg,
      agentDir,
      agentId,
      contentType: saved.contentType,
      visionModel,
    });
  } catch (err) {
    logVerbose(`telegram: failed to describe custom emoji: ${String(err)}`);
    return null;
  }
}
