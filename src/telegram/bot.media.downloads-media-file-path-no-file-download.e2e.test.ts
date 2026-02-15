import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { onSpy, sendChatActionSpy } from "./bot.media.e2e-harness.js";

const cacheStickerSpy = vi.fn();
const getCachedStickerSpy = vi.fn();
const describeStickerImageSpy = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

const sleep = async (ms: number) => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

async function createBotHandler(): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  const { createTelegramBot } = await import("./bot.js");
  const replyModule = await import("../auto-reply/reply.js");
  const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

  onSpy.mockReset();
  replySpy.mockReset();
  sendChatActionSpy.mockReset();

  const runtimeError = vi.fn();
  createTelegramBot({
    token: "tok",
    testTimings: TELEGRAM_TEST_TIMINGS,
    runtime: {
      log: vi.fn(),
      error: runtimeError,
      exit: () => {
        throw new Error("exit");
      },
    },
  });
  const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  expect(handler).toBeDefined();

  return { handler, replySpy, runtimeError };
}

function mockTelegramFileDownload(params: {
  contentType: string;
  bytes: Uint8Array;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch" as never).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => params.contentType },
    arrayBuffer: async () => params.bytes.buffer,
  } as Response);
}

beforeEach(() => {
  vi.useRealTimers();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  resolvePinnedHostnameSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
});

afterEach(() => {
  lookupMock.mockReset();
  resolvePinnedHostnameSpy?.mockRestore();
  resolvePinnedHostnameSpy = null;
});

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: (...args: unknown[]) => cacheStickerSpy(...args),
  getCachedSticker: (...args: unknown[]) => getCachedStickerSpy(...args),
  describeStickerImage: (...args: unknown[]) => describeStickerImageSpy(...args),
}));

describe("telegram inbound media", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "downloads media via file_path (no file.download)",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramFileDownload({
        contentType: "image/jpeg",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      });

      await handler({
        message: {
          message_id: 1,
          chat: { id: 1234, type: "private" },
          photo: [{ file_id: "fid" }],
          date: 1736380800, // 2025-01-09T00:00:00Z
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/1.jpg" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/photos/1.jpg",
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("<media:image>");

      fetchSpy.mockRestore();
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it("prefers proxyFetch over global fetch", async () => {
    const { createTelegramBot } = await import("./bot.js");

    onSpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi.spyOn(globalThis, "fetch" as never).mockImplementation(() => {
      throw new Error("global fetch should not be called");
    });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as Response);

    createTelegramBot({
      token: "tok",
      testTimings: TELEGRAM_TEST_TIMINGS,
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(handler).toBeDefined();

    await handler({
      message: {
        message_id: 2,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "photos/2.jpg" }),
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottok/photos/2.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );

    globalFetchSpy.mockRestore();
  });

  it("logs a handler error when getFile returns no file_path", async () => {
    const { createTelegramBot } = await import("./bot.js");
    const replyModule = await import("../auto-reply/reply.js");
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

    onSpy.mockReset();
    replySpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

    createTelegramBot({
      token: "tok",
      testTimings: TELEGRAM_TEST_TIMINGS,
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(handler).toBeDefined();

    await handler({
      message: {
        message_id: 3,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledTimes(1);
    const msg = String(runtimeError.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("handler failed:");
    expect(msg).toContain("file_path");

    fetchSpy.mockRestore();
  });
});

describe("telegram media groups", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const MEDIA_GROUP_FLUSH_MS = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 60;

  it(
    "buffers messages with same media_group_id and processes them together",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const runtimeError = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);

      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const first = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          caption: "Here are my photos",
          date: 1736380800,
          media_group_id: "album123",
          photo: [{ file_id: "photo1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/photo1.jpg" }),
      });

      const second = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          date: 1736380801,
          media_group_id: "album123",
          photo: [{ file_id: "photo2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/photo2.jpg" }),
      });

      await first;
      await second;

      expect(replySpy).not.toHaveBeenCalled();
      await sleep(MEDIA_GROUP_FLUSH_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("Here are my photos");
      expect(payload.MediaPaths).toHaveLength(2);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "processes separate media groups independently",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);

      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const first = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          caption: "Album A",
          date: 1736380800,
          media_group_id: "albumA",
          photo: [{ file_id: "photoA1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/photoA1.jpg" }),
      });

      const second = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          caption: "Album B",
          date: 1736380801,
          media_group_id: "albumB",
          photo: [{ file_id: "photoB1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/photoB1.jpg" }),
      });

      await Promise.all([first, second]);

      expect(replySpy).not.toHaveBeenCalled();
      await sleep(MEDIA_GROUP_FLUSH_MS);

      expect(replySpy).toHaveBeenCalledTimes(2);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "retries buffered media groups after transient processing failures",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const runtimeError = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);
      replySpy.mockRejectedValueOnce(new Error("transient media flush failure"));

      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      await Promise.all([
        handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 101,
            caption: "Retry album",
            date: 1736380800,
            media_group_id: "album-retry",
            photo: [{ file_id: "retry-1" }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/retry-1.jpg" }),
        }),
        handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 102,
            date: 1736380801,
            media_group_id: "album-retry",
            photo: [{ file_id: "retry-2" }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/retry-2.jpg" }),
        }),
      ]);

      await sleep(MEDIA_GROUP_FLUSH_MS * 2);

      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("media group handler failed:"),
      );
      const payload = replySpy.mock.calls[1]?.[0] as { Body?: string; MediaPaths?: string[] };
      expect(payload.Body).toContain("Retry album");
      expect(payload.MediaPaths).toHaveLength(2);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "keeps late media items when they arrive during an in-flight flush",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);
      let releaseFirstFlush: (() => void) | undefined;
      replySpy.mockImplementationOnce(async (_ctx, opts) => {
        await opts?.onReplyStart?.();
        await new Promise<void>((resolve) => {
          releaseFirstFlush = resolve;
        });
      });

      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      await Promise.all([
        handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 401,
            caption: "Album while flushing",
            date: 1736380800,
            media_group_id: "album-race",
            photo: [{ file_id: "race-1" }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/race-1.jpg" }),
        }),
        handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 402,
            date: 1736380801,
            media_group_id: "album-race",
            photo: [{ file_id: "race-2" }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/race-2.jpg" }),
        }),
      ]);

      await vi.waitFor(() => {
        expect(releaseFirstFlush).toBeTypeOf("function");
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 403,
          date: 1736380802,
          media_group_id: "album-race",
          photo: [{ file_id: "race-3" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/race-3.jpg" }),
      });

      releaseFirstFlush?.();
      await sleep(MEDIA_GROUP_FLUSH_MS * 3);

      expect(replySpy).toHaveBeenCalledTimes(2);
      const firstPayload = replySpy.mock.calls[0]?.[0] as { MediaPaths?: string[] };
      const secondPayload = replySpy.mock.calls[1]?.[0] as { MediaPaths?: string[] };
      expect(firstPayload.MediaPaths).toHaveLength(2);
      expect(secondPayload.MediaPaths).toHaveLength(1);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("telegram stickers", () => {
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  beforeEach(() => {
    cacheStickerSpy.mockReset();
    getCachedStickerSpy.mockReset();
    describeStickerImageSpy.mockReset();
  });

  it(
    "downloads static sticker (WEBP) and includes sticker metadata",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramFileDownload({
        contentType: "image/webp",
        bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF header
      });

      await handler({
        message: {
          message_id: 100,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "sticker_file_id_123",
            file_unique_id: "sticker_unique_123",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🎉",
            set_name: "TestStickerPack",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/stickers/sticker.webp",
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("<media:sticker>");
      expect(payload.Sticker?.emoji).toBe("🎉");
      expect(payload.Sticker?.setName).toBe("TestStickerPack");
      expect(payload.Sticker?.fileId).toBe("sticker_file_id_123");

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes cached sticker metadata on cache hit",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();
      sendChatActionSpy.mockReset();

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      const runtimeError = vi.fn();
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      } as Response);

      await handler({
        message: {
          message_id: 103,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "new_file_id",
            file_unique_id: "sticker_unique_456",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🔥",
            set_name: "NewSet",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(cacheStickerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: "new_file_id",
          emoji: "🔥",
          setName: "NewSet",
        }),
      );
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Sticker?.fileId).toBe("new_file_id");
      expect(payload.Sticker?.cachedDescription).toBe("Cached description");

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "skips animated stickers (TGS format)",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

      await handler({
        message: {
          message_id: 101,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: true, // TGS format
            is_video: false,
            emoji: "😎",
            set_name: "AnimatedPack",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/animated.tgs" }),
      });

      // Should not attempt to download animated stickers
      expect(fetchSpy).not.toHaveBeenCalled();
      // Should still process the message (as text-only, no media)
      expect(replySpy).not.toHaveBeenCalled(); // No text content, so no reply generated
      expect(runtimeError).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "skips video stickers (WEBM format)",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

      await handler({
        message: {
          message_id: 102,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: true, // WEBM format
            emoji: "🎬",
            set_name: "VideoPack",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/video.webm" }),
      });

      // Should not attempt to download video stickers
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
      expect(runtimeError).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );
});

describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const TEXT_FRAGMENT_FLUSH_MS = TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 80;

  it(
    "buffers near-limit text and processes sequential parts as one message",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 10,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 11,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await sleep(TEXT_FRAGMENT_FLUSH_MS);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as { RawBody?: string; Body?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "retries buffered text fragments after transient processing failures",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const runtimeError = vi.fn();
      replySpy.mockRejectedValueOnce(new Error("transient text flush failure"));

      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const part1 = "X".repeat(4050);
      const part2 = "Y".repeat(50);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 201,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 202,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await sleep(TEXT_FRAGMENT_FLUSH_MS * 2);

      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("text fragment handler failed:"),
      );
      const payload = replySpy.mock.calls[1]?.[0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps late text fragments when they arrive during an in-flight flush",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      let releaseFirstFlush: (() => void) | undefined;
      replySpy.mockImplementationOnce(async (_ctx, opts) => {
        await opts?.onReplyStart?.();
        await new Promise<void>((resolve) => {
          releaseFirstFlush = resolve;
        });
      });

      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const part1 = "P".repeat(4050);
      const part2 = "Q".repeat(4050);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 501,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await vi.waitFor(() => {
        expect(releaseFirstFlush).toBeTypeOf("function");
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 502,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      releaseFirstFlush?.();
      await sleep(TEXT_FRAGMENT_FLUSH_MS * 3);

      expect(replySpy).toHaveBeenCalledTimes(2);
      const firstRawBody = String(replySpy.mock.calls[0]?.[0]?.RawBody ?? "");
      const secondRawBody = String(replySpy.mock.calls[1]?.[0]?.RawBody ?? "");
      expect(firstRawBody).toContain(part1.slice(0, 32));
      expect(secondRawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps retrying a failed fragment batch after key reuse",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const runtimeError = vi.fn();
      replySpy.mockRejectedValueOnce(new Error("transient text flush failure (1)"));
      replySpy.mockRejectedValueOnce(new Error("transient text flush failure (2)"));

      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const part1 = "M".repeat(4050);
      const part2 = "N".repeat(50);
      const nextBatch = "Z".repeat(4050);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 301,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 302,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      // Force immediate flush of the first buffered batch, then start a new batch on the same key.
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 305,
          date: 1736380802,
          text: nextBatch,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await sleep(TEXT_FRAGMENT_FLUSH_MS * 4);

      expect(replySpy).toHaveBeenCalledTimes(4);
      expect(runtimeError).toHaveBeenCalledTimes(2);
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("text fragment handler failed:"),
      );
      const rawBodies = replySpy.mock.calls.map((call) => String(call[0]?.RawBody ?? ""));
      expect(
        rawBodies.some(
          (body) => body.includes(part1.slice(0, 32)) && body.includes(part2.slice(0, 32)),
        ),
      ).toBe(true);
      expect(rawBodies.some((body) => body.includes(nextBatch.slice(0, 32)))).toBe(true);
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
