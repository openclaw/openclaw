import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import type { TelegramContext } from "./types.js";
import { deliverReplies, resolveMedia } from "./delivery.js";

const loadWebMedia = vi.fn();
const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;
type DeliverRepliesParams = Parameters<typeof deliverReplies>[0];
type DeliverWithParams = Omit<
  DeliverRepliesParams,
  "chatId" | "token" | "replyToMode" | "textLimit"
> &
  Partial<Pick<DeliverRepliesParams, "replyToMode" | "textLimit">>;
type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

vi.mock("../../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

const mockFetchRemoteMedia = vi.fn();
vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) => mockFetchRemoteMedia(...args),
}));

const mockSaveMediaBuffer = vi.fn();
vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => mockSaveMediaBuffer(...args),
}));

const mockGetCachedSticker = vi.fn();
const mockCacheSticker = vi.fn();
vi.mock("../sticker-cache.js", () => ({
  getCachedSticker: (...args: unknown[]) => mockGetCachedSticker(...args),
  cacheSticker: (...args: unknown[]) => mockCacheSticker(...args),
}));

vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

function createRuntime(withLog = true): RuntimeStub {
  return {
    error: vi.fn(),
    log: withLog ? vi.fn() : vi.fn(),
    exit: vi.fn(),
  };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  return { api } as unknown as Bot;
}

async function deliverWith(params: DeliverWithParams) {
  await deliverReplies({
    ...baseDeliveryParams,
    ...params,
  });
}

function mockMediaLoad(fileName: string, contentType: string, data: string) {
  loadWebMedia.mockResolvedValueOnce({
    buffer: Buffer.from(data),
    contentType,
    fileName,
  });
}

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = createRuntime(false);

    await deliverWith({
      replies: [{ audioAsVoice: true }],
      runtime,
      bot: createBot(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = createRuntime(false);
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = createBot({ sendVoice });
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      runtime,
      bot,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      runtime,
      bot,
    });

    expect(sendPhoto).toHaveBeenCalledWith(
      "123",
      expect.anything(),
      expect.objectContaining({
        caption: "hi <b>boss</b>",
        parse_mode: "HTML",
      }),
    );
  });

  it("passes mediaLocalRoots to media loading", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });
    const mediaLocalRoots = ["/tmp/workspace-work"];

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "/tmp/workspace-work/photo.jpg" }],
      runtime,
      bot,
      mediaLocalRoots,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/workspace-work/photo.jpg", {
      localRoots: mediaLocalRoots,
    });
  });

  it("includes link_preview_options when linkPreview is false", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: false,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it("includes message_thread_id for DM topics", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello" }],
      runtime,
      bot,
      thread: { id: 42, scope: "dm" },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it("does not include link_preview_options when linkPreview is true", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        link_preview_options: expect.anything(),
      }),
    );
  });

  it("uses reply_to_message_id when quote text is provided", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteText: "quoted text",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        reply_to_message_id: 500,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        reply_parameters: expect.anything(),
      }),
    );
  });

  it("falls back to text when sendVoice fails with VOICE_MESSAGES_FORBIDDEN", async () => {
    const runtime = createRuntime();
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: "123" },
    });
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "Hello there", audioAsVoice: true },
      ],
      runtime,
      bot,
    });

    // Voice was attempted but failed
    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Fallback to text succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello there"),
      expect.any(Object),
    );
  });

  it("rethrows non-VOICE_MESSAGES_FORBIDDEN errors from sendVoice", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(new Error("Network error"));
    const sendMessage = vi.fn();
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", text: "Hello", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("Network error");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Text fallback should NOT be attempted for other errors
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rethrows VOICE_MESSAGES_FORBIDDEN when no text fallback is available", async () => {
    const runtime = createRuntime();
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn();
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("VOICE_MESSAGES_FORBIDDEN");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends sticker when stickerId is provided", async () => {
    const runtime = { error: vi.fn() };
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 20,
      chat: { id: "123" },
    });
    const bot = { api: { sendSticker } } as unknown as Bot;

    await deliverReplies({
      replies: [{ stickerId: "sticker-file-id-123" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(sendSticker).toHaveBeenCalledTimes(1);
    expect(sendSticker).toHaveBeenCalledWith("123", "sticker-file-id-123", expect.any(Object));
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("sends sticker and text when both provided", async () => {
    const runtime = { error: vi.fn() };
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 21,
      chat: { id: "123" },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 22,
      chat: { id: "123" },
    });
    const bot = { api: { sendSticker, sendMessage } } as unknown as Bot;

    await deliverReplies({
      replies: [{ stickerId: "sticker-file-id-456", text: "Look at this!" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(sendSticker).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Look at this!"),
      expect.any(Object),
    );
  });

  it("does not send sticker when stickerId is absent (unchanged behavior)", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendSticker = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 23,
      chat: { id: "123" },
    });
    const bot = { api: { sendSticker, sendMessage } } as unknown as Bot;

    await deliverReplies({
      replies: [{ text: "Just text" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(sendSticker).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMedia", () => {
  const TOKEN = "test-token";
  const MAX_BYTES = 5 * 1024 * 1024;

  function makeFetchMock(
    responses: Record<string, { ok: boolean; json?: unknown; buffer?: Buffer }>,
  ) {
    return vi.fn(async (url: string) => {
      const match = Object.entries(responses).find(([pattern]) => url.includes(pattern));
      const resp = match?.[1] ?? { ok: false };
      return {
        ok: resp.ok,
        status: resp.ok ? 200 : 404,
        json: async () => resp.json,
        arrayBuffer: async () => (resp.buffer ?? Buffer.alloc(0)).buffer,
        headers: new Map([["content-type", "image/webp"]]),
      };
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    mockFetchRemoteMedia.mockReset();
    mockSaveMediaBuffer.mockReset();
    mockGetCachedSticker.mockReset();
    mockCacheSticker.mockReset();
  });

  it("video sticker with thumbnail returns media with isVideo metadata", async () => {
    const proxyFetch = makeFetchMock({
      getFile: {
        ok: true,
        json: { ok: true, result: { file_path: "thumbnails/thumb.webp" } },
      },
      "file/bot": {
        ok: true,
        buffer: Buffer.from("thumb-data"),
      },
    });
    mockGetCachedSticker.mockReturnValue(null);
    mockFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("thumb-data"),
      contentType: "image/webp",
      fileName: "thumb.webp",
    });
    mockSaveMediaBuffer.mockResolvedValue({
      path: "/tmp/thumb.webp",
      contentType: "image/webp",
    });

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          emoji: "😘",
          set_name: "VideoStickerPack",
          thumbnail: {
            file_id: "thumb-file-id",
            file_unique_id: "thumb-unique-id",
            width: 128,
            height: 128,
          },
        },
      },
      getFile: vi.fn(),
    };

    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).not.toBeNull();
    expect(result!.stickerMetadata?.isVideo).toBe(true);
    expect(result!.stickerMetadata?.emoji).toBe("😘");
    expect(result!.stickerMetadata?.setName).toBe("VideoStickerPack");
    expect(result!.placeholder).toBe("<media:sticker>");
  });

  it("animated sticker with thumbnail returns media with isAnimated metadata", async () => {
    const proxyFetch = makeFetchMock({
      getFile: {
        ok: true,
        json: { ok: true, result: { file_path: "thumbnails/thumb.webp" } },
      },
      "file/bot": {
        ok: true,
        buffer: Buffer.from("thumb-data"),
      },
    });
    mockGetCachedSticker.mockReturnValue(null);
    mockFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("thumb-data"),
      contentType: "image/webp",
      fileName: "thumb.webp",
    });
    mockSaveMediaBuffer.mockResolvedValue({
      path: "/tmp/thumb.webp",
      contentType: "image/webp",
    });

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: true,
          is_video: false,
          emoji: "🎉",
          thumbnail: {
            file_id: "thumb-file-id",
            file_unique_id: "thumb-unique-id",
            width: 128,
            height: 128,
          },
        },
      },
      getFile: vi.fn(),
    };

    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).not.toBeNull();
    expect(result!.stickerMetadata?.isAnimated).toBe(true);
    expect(result!.stickerMetadata?.isVideo).toBeUndefined();
  });

  it("video sticker with no thumbnail and no cache returns null", async () => {
    mockGetCachedSticker.mockReturnValue(null);

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          // no thumbnail
        },
      },
      getFile: vi.fn(),
    };

    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).toBeNull();
  });

  it("video sticker with cache hit returns cached description", async () => {
    mockGetCachedSticker.mockReturnValue({
      fileId: "sticker-file-id",
      fileUniqueId: "sticker-unique-id",
      emoji: "😘",
      setName: "VideoStickerPack",
      description: "A kissing face",
      cachedAt: "2026-01-26T12:00:00.000Z",
    });

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          emoji: "😘",
          set_name: "VideoStickerPack",
          // no thumbnail needed — cache covers it
        },
      },
      getFile: vi.fn(),
    };

    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).not.toBeNull();
    expect(result!.stickerMetadata?.cachedDescription).toBe("A kissing face");
    expect(result!.stickerMetadata?.isVideo).toBe(true);
    expect(result!.path).toBe("");
  });

  it("thumbnail download failure returns null gracefully", async () => {
    const proxyFetch = makeFetchMock({
      getFile: { ok: false },
    });
    mockGetCachedSticker.mockReturnValue(null);

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          thumbnail: {
            file_id: "thumb-file-id",
            file_unique_id: "thumb-unique-id",
            width: 128,
            height: 128,
          },
        },
      },
      getFile: vi.fn(),
    };

    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).toBeNull();
  });

  it("static WEBP sticker works unchanged (regression guard)", async () => {
    mockGetCachedSticker.mockReturnValue(null);
    mockFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("webp-data"),
      contentType: "image/webp",
      fileName: "sticker.webp",
    });
    mockSaveMediaBuffer.mockResolvedValue({
      path: "/tmp/sticker.webp",
      contentType: "image/webp",
    });

    const ctx: TelegramContext = {
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 123, type: "private" },
        sticker: {
          file_id: "sticker-file-id",
          file_unique_id: "sticker-unique-id",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          emoji: "😎",
          set_name: "StaticPack",
        },
      },
      getFile: vi.fn().mockResolvedValue({ file_path: "stickers/sticker.webp" }),
    };

    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const result = await resolveMedia(ctx, MAX_BYTES, TOKEN, proxyFetch);

    expect(result).not.toBeNull();
    expect(result!.stickerMetadata?.isVideo).toBeUndefined();
    expect(result!.stickerMetadata?.isAnimated).toBeUndefined();
    expect(result!.stickerMetadata?.emoji).toBe("😎");
    expect(result!.stickerMetadata?.setName).toBe("StaticPack");
    expect(result!.path).toBe("/tmp/sticker.webp");
  });
});
