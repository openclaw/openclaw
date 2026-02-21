import type { MessageEntity } from "@grammyjs/types";
import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCustomEmojiAnnotations } from "./custom-emoji.js";

const mockGetCachedSticker = vi.fn();
const mockCacheSticker = vi.fn();
const mockDescribeStickerImage = vi.fn();

vi.mock("./sticker-cache.js", () => ({
  getCachedSticker: (...args: unknown[]) => mockGetCachedSticker(...args),
  cacheSticker: (...args: unknown[]) => mockCacheSticker(...args),
  describeStickerImage: (...args: unknown[]) => mockDescribeStickerImage(...args),
}));

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("thumb"),
    contentType: "image/webp",
    fileName: "thumb.webp",
  }),
}));

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockResolvedValue({
    path: "/tmp/thumb.webp",
    contentType: "image/webp",
  }),
}));

function makeBot(
  stickers: Array<{
    file_id: string;
    custom_emoji_id: string;
    emoji?: string;
    thumbnail?: { file_id: string };
  }>,
) {
  return {
    api: {
      getCustomEmojiStickers: vi.fn().mockResolvedValue(
        stickers.map((s) => ({
          file_id: s.file_id,
          file_unique_id: `unique-${s.file_id}`,
          type: "custom_emoji" as const,
          width: 100,
          height: 100,
          is_animated: false,
          is_video: false,
          custom_emoji_id: s.custom_emoji_id,
          emoji: s.emoji ?? "⭐",
          thumbnail: s.thumbnail ?? {
            file_id: `thumb-${s.file_id}`,
            file_unique_id: `thumb-unique-${s.file_id}`,
            width: 100,
            height: 100,
          },
        })),
      ),
    },
  } as unknown as Bot;
}

const CFG = {} as Parameters<typeof resolveCustomEmojiAnnotations>[0]["cfg"];
const TOKEN = "test-token";

describe("resolveCustomEmojiAnnotations", () => {
  beforeEach(() => {
    mockGetCachedSticker.mockReset();
    mockCacheSticker.mockReset();
    mockDescribeStickerImage.mockReset();
  });

  it("returns original text when no custom emoji entities", async () => {
    const bot = makeBot([]);
    const result = await resolveCustomEmojiAnnotations({
      text: "Hello world",
      entities: [],
      bot,
      token: TOKEN,
      cfg: CFG,
    });

    expect(result.annotatedText).toBe("Hello world");
    expect(result.annotations).toHaveLength(0);
  });

  it("annotates custom emoji with cached description", async () => {
    mockGetCachedSticker.mockReturnValue({
      fileId: "file1",
      fileUniqueId: "ce:emoji-id-1",
      description: "a sparkling star",
      cachedAt: "2026-01-26T12:00:00.000Z",
    });

    const bot = makeBot([]);
    const entities: MessageEntity[] = [
      {
        type: "custom_emoji",
        offset: 6,
        length: 1,
        custom_emoji_id: "emoji-id-1",
      } as MessageEntity,
    ];

    const result = await resolveCustomEmojiAnnotations({
      text: "Hello ⭐ world",
      entities,
      bot,
      token: TOKEN,
      cfg: CFG,
    });

    expect(result.annotatedText).toBe("Hello ⭐[emoji: a sparkling star] world");
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].description).toBe("a sparkling star");
    // Should not call bot API since it was cached
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(bot.api.getCustomEmojiStickers).not.toHaveBeenCalled();
  });

  it("fetches and caches uncached custom emoji", async () => {
    mockGetCachedSticker.mockReturnValue(null);
    mockDescribeStickerImage.mockResolvedValue("a cute cat face");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { file_path: "thumbnails/thumb.webp" } }),
    });

    const bot = makeBot([{ file_id: "file1", custom_emoji_id: "emoji-id-1" }]);
    const entities: MessageEntity[] = [
      {
        type: "custom_emoji",
        offset: 6,
        length: 1,
        custom_emoji_id: "emoji-id-1",
      } as MessageEntity,
    ];

    const result = await resolveCustomEmojiAnnotations({
      text: "Hello ⭐ world",
      entities,
      bot,
      token: TOKEN,
      cfg: CFG,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.annotatedText).toBe("Hello ⭐[emoji: a cute cat face] world");
    expect(mockCacheSticker).toHaveBeenCalledWith(
      expect.objectContaining({
        fileUniqueId: "ce:emoji-id-1",
        description: "a cute cat face",
      }),
    );
  });

  it("skips annotation when vision description fails", async () => {
    mockGetCachedSticker.mockReturnValue(null);
    mockDescribeStickerImage.mockResolvedValue(null);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { file_path: "thumbnails/thumb.webp" } }),
    });

    const bot = makeBot([{ file_id: "file1", custom_emoji_id: "emoji-id-1" }]);
    const entities: MessageEntity[] = [
      {
        type: "custom_emoji",
        offset: 6,
        length: 1,
        custom_emoji_id: "emoji-id-1",
      } as MessageEntity,
    ];

    const result = await resolveCustomEmojiAnnotations({
      text: "Hello ⭐ world",
      entities,
      bot,
      token: TOKEN,
      cfg: CFG,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Text unchanged since description failed
    expect(result.annotatedText).toBe("Hello ⭐ world");
    expect(result.annotations).toHaveLength(0);
  });
});
