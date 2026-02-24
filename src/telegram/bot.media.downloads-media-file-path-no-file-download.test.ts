import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const TELEGRAM_BOT_IMPORT_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 150_000;
let createTelegramBot: typeof import("./bot.js").createTelegramBot;
let replySpy: ReturnType<typeof vi.fn>;

async function createBotHandler(): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  return createBotHandlerWithOptions({});
}

async function createBotHandlerWithOptions(options: {
  proxyFetch?: typeof fetch;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
}): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  onSpy.mockClear();
  replySpy.mockClear();
  sendChatActionSpy.mockClear();

  const runtimeError = options.runtimeError ?? vi.fn();
  const runtimeLog = options.runtimeLog ?? vi.fn();
  createTelegramBot({
    token: "tok",
    testTimings: TELEGRAM_TEST_TIMINGS,
    ...(options.proxyFetch ? { proxyFetch: options.proxyFetch } : {}),
    runtime: {
      log: runtimeLog as (...data: unknown[]) => void,
      error: runtimeError as (...data: unknown[]) => void,
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
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => params.contentType },
    arrayBuffer: async () => params.bytes.buffer,
  } as unknown as Response);
}

function mockTelegramPngDownload(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
  } as unknown as Response);
}

beforeEach(() => {
  vi.useRealTimers();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  resolvePinnedHostnameSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
});

afterEach(() => {
  lookupMock.mockClear();
  resolvePinnedHostnameSpy?.mockRestore();
  resolvePinnedHostnameSpy = null;
});

beforeAll(async () => {
  ({ createTelegramBot } = await import("./bot.js"));
  const replyModule = await import("../auto-reply/reply.js");
  replySpy = (replyModule as unknown as { __replySpy: ReturnType<typeof vi.fn> }).__replySpy;
}, TELEGRAM_BOT_IMPORT_TIMEOUT_MS);

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: (...args: unknown[]) => cacheStickerSpy(...args),
  getCachedSticker: (...args: unknown[]) => getCachedStickerSpy(...args),
  describeStickerImage: (...args: unknown[]) => describeStickerImageSpy(...args),
}));

describe("telegram inbound media", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "handles file_path media downloads and missing file_path safely",
    async () => {
      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({
        runtimeLog,
        runtimeError,
      });

      for (const scenario of [
        {
          name: "downloads via file_path",
          messageId: 1,
          getFile: async () => ({ file_path: "photos/1.jpg" }),
          setupFetch: () =>
            mockTelegramFileDownload({
              contentType: "image/jpeg",
              bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
            }),
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.runtimeError).not.toHaveBeenCalled();
            expect(params.fetchSpy).toHaveBeenCalledWith(
              "https://api.telegram.org/file/bottok/photos/1.jpg",
              expect.objectContaining({ redirect: "manual" }),
            );
            expect(params.replySpy).toHaveBeenCalledTimes(1);
            const payload = params.replySpy.mock.calls[0][0];
            expect(payload.Body).toContain("<media:image>");
          },
        },
        {
          name: "skips when file_path is missing",
          messageId: 2,
          getFile: async () => ({}),
          setupFetch: () => vi.spyOn(globalThis, "fetch"),
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.fetchSpy).not.toHaveBeenCalled();
            expect(params.replySpy).not.toHaveBeenCalled();
            expect(params.runtimeError).not.toHaveBeenCalled();
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        const fetchSpy = scenario.setupFetch();

        await handler({
          message: {
            message_id: scenario.messageId,
            chat: { id: 1234, type: "private" },
            photo: [{ file_id: "fid" }],
            date: 1736380800, // 2025-01-09T00:00:00Z
          },
          me: { username: "openclaw_bot" },
          getFile: scenario.getFile,
        });

        scenario.assert({ fetchSpy, replySpy, runtimeError });
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it("prefers proxyFetch over global fetch", async () => {
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("global fetch should not be called");
    });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as unknown as Response);

    const { handler } = await createBotHandlerWithOptions({
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtimeLog,
      runtimeError,
    });

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

  it("captures pin and venue location payload fields", async () => {
    const { handler, replySpy } = await createBotHandler();

    const cases = [
      {
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 5,
          caption: "Meet here",
          date: 1736380800,
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            horizontal_accuracy: 12,
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Meet here");
          expect(payload.Body).toContain("48.858844");
          expect(payload.LocationLat).toBe(48.858844);
          expect(payload.LocationLon).toBe(2.294351);
          expect(payload.LocationSource).toBe("pin");
          expect(payload.LocationIsLive).toBe(false);
        },
      },
      {
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 6,
          date: 1736380800,
          venue: {
            title: "Eiffel Tower",
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Eiffel Tower");
          expect(payload.LocationName).toBe("Eiffel Tower");
          expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
          expect(payload.LocationSource).toBe("place");
        },
      },
    ] as const;

    for (const testCase of cases) {
      replySpy.mockClear();
      await handler({
        message: testCase.message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as Record<string, unknown>;
      testCase.assert(payload);
    }
  });
});

describe("telegram media groups", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const MEDIA_GROUP_FLUSH_MS = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 40;

  it(
    "handles same-group buffering and separate-group independence",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        for (const scenario of [
          {
            messages: [
              {
                chat: { id: 42, type: "private" as const },
                message_id: 1,
                caption: "Here are my photos",
                date: 1736380800,
                media_group_id: "album123",
                photo: [{ file_id: "photo1" }],
                filePath: "photos/photo1.jpg",
              },
              {
                chat: { id: 42, type: "private" as const },
                message_id: 2,
                date: 1736380801,
                media_group_id: "album123",
                photo: [{ file_id: "photo2" }],
                filePath: "photos/photo2.jpg",
              },
            ],
            expectedReplyCount: 1,
            assert: (replySpy: ReturnType<typeof vi.fn>) => {
              const payload = replySpy.mock.calls[0]?.[0];
              expect(payload?.Body).toContain("Here are my photos");
              expect(payload?.MediaPaths).toHaveLength(2);
            },
          },
          {
            messages: [
              {
                chat: { id: 42, type: "private" as const },
                message_id: 11,
                caption: "Album A",
                date: 1736380800,
                media_group_id: "albumA",
                photo: [{ file_id: "photoA1" }],
                filePath: "photos/photoA1.jpg",
              },
              {
                chat: { id: 42, type: "private" as const },
                message_id: 12,
                caption: "Album B",
                date: 1736380801,
                media_group_id: "albumB",
                photo: [{ file_id: "photoB1" }],
                filePath: "photos/photoB1.jpg",
              },
            ],
            expectedReplyCount: 2,
            assert: () => {},
          },
        ]) {
          replySpy.mockClear();
          runtimeError.mockClear();

          await Promise.all(
            scenario.messages.map((message) =>
              handler({
                message,
                me: { username: "openclaw_bot" },
                getFile: async () => ({ file_path: message.filePath }),
              }),
            ),
          );

          expect(replySpy).not.toHaveBeenCalled();
          await vi.waitFor(
            () => {
              expect(replySpy).toHaveBeenCalledTimes(scenario.expectedReplyCount);
            },
            { timeout: MEDIA_GROUP_FLUSH_MS * 4, interval: 2 },
          );

          expect(runtimeError).not.toHaveBeenCalled();
          scenario.assert(replySpy);
        }
      } finally {
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("telegram forwarded bursts", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const FORWARD_BURST_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "coalesces forwarded text + forwarded attachment into a single processing turn with default debounce config",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      vi.useFakeTimers();

      try {
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 21,
            text: "Look at this",
            date: 1736380800,
            forward_origin: { type: "hidden_user", date: 1736380700, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 22,
            date: 1736380801,
            photo: [{ file_id: "fwd_photo_1" }],
            forward_origin: { type: "hidden_user", date: 1736380701, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/fwd1.jpg" }),
        });

        await vi.runAllTimersAsync();
        expect(replySpy).toHaveBeenCalledTimes(1);

        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replySpy.mock.calls[0][0];
        expect(payload.Body).toContain("Look at this");
        expect(payload.MediaPaths).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
        vi.useRealTimers();
      }
    },
    FORWARD_BURST_TEST_TIMEOUT_MS,
  );
});

describe("telegram stickers", () => {
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  beforeEach(() => {
    cacheStickerSpy.mockClear();
    getCachedStickerSpy.mockClear();
    describeStickerImageSpy.mockClear();
    // Re-seed defaults so per-test overrides do not leak when using mockClear.
    getCachedStickerSpy.mockReturnValue(undefined);
    describeStickerImageSpy.mockReturnValue(undefined);
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
      const { handler, replySpy, runtimeError } = await createBotHandler();

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      } as unknown as Response);

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
    "skips animated and video sticker formats that cannot be downloaded",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();

      for (const scenario of [
        {
          messageId: 101,
          filePath: "stickers/animated.tgs",
          sticker: {
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: true,
            is_video: false,
            emoji: "😎",
            set_name: "AnimatedPack",
          },
        },
        {
          messageId: 102,
          filePath: "stickers/video.webm",
          sticker: {
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: true,
            emoji: "🎬",
            set_name: "VideoPack",
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await handler({
          message: {
            message_id: scenario.messageId,
            chat: { id: 1234, type: "private" },
            sticker: scenario.sticker,
            date: 1736380800,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: scenario.filePath }),
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      }
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
      onSpy.mockClear();
      replySpy.mockClear();
      vi.useFakeTimers();
      try {
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
        await vi.advanceTimersByTimeAsync(TEXT_FRAGMENT_FLUSH_MS * 2);
        expect(replySpy).toHaveBeenCalledTimes(1);

        const payload = replySpy.mock.calls[0][0] as { RawBody?: string; Body?: string };
        expect(payload.RawBody).toContain(part1.slice(0, 32));
        expect(payload.RawBody).toContain(part2.slice(0, 32));
      } finally {
        vi.useRealTimers();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
