import type { Message } from "@grammyjs/types";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const fetchRemoteMedia = vi.fn();

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
}));

vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
}));

vi.mock("../../globals.js", () => ({
  danger: (s: string) => s,
  warn: (s: string) => s,
  logVerbose: () => {},
}));

vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { resolveMedia } = await import("./delivery.js");
const MAX_MEDIA_BYTES = 10_000_000;
const BOT_TOKEN = "tok123";

function makeCtx(
  mediaField: "voice" | "audio" | "photo" | "video" | "document",
  getFile: TelegramContext["getFile"],
  fileNameOverride?: string,
): TelegramContext {
  const msg: Record<string, unknown> = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
  };
  if (mediaField === "voice") {
    msg.voice = { file_id: "v1", duration: 5, file_unique_id: "u1" };
  }
  if (mediaField === "audio") {
    msg.audio = { file_id: "a1", duration: 5, file_unique_id: "u2", file_name: fileNameOverride };
  }
  if (mediaField === "photo") {
    msg.photo = [{ file_id: "p1", width: 100, height: 100 }];
  }
  if (mediaField === "video") {
    msg.video = {
      file_id: "vid1",
      duration: 10,
      file_unique_id: "u3",
      file_name: fileNameOverride,
    };
  }
  if (mediaField === "document") {
    msg.document = { file_id: "d1", file_unique_id: "u4", file_name: fileNameOverride };
  }
  return {
    message: msg as unknown as Message,
    me: {
      id: 1,
      is_bot: true,
      first_name: "bot",
      username: "bot",
    } as unknown as TelegramContext["me"],
    getFile,
  };
}

function setupTransientGetFileRetry() {
  const getFile = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network request for 'getFile' failed!"))
    .mockResolvedValueOnce({ file_path: "voice/file_0.oga" });

  fetchRemoteMedia.mockResolvedValueOnce({
    buffer: Buffer.from("audio"),
    contentType: "audio/ogg",
    fileName: "file_0.oga",
  });
  saveMediaBuffer.mockResolvedValueOnce({
    path: "/tmp/file_0.oga",
    contentType: "audio/ogg",
  });

  return getFile;
}

function createFileTooBigError(): Error {
  return new Error("GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)");
}

async function expectTransientGetFileRetrySuccess() {
  const getFile = setupTransientGetFileRetry();
  const promise = resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
  await flushRetryTimers();
  const result = await promise;
  expect(getFile).toHaveBeenCalledTimes(2);
  expect(fetchRemoteMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      url: `https://api.telegram.org/file/bot${BOT_TOKEN}/voice/file_0.oga`,
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        allowedHostnames: ["api.telegram.org"],
      },
    }),
  );
  return result;
}

async function flushRetryTimers() {
  await vi.runAllTimersAsync();
}

describe("resolveMedia getFile retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries getFile on transient failure and succeeds on second attempt", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    expect(result).toEqual(
      expect.objectContaining({ path: "/tmp/file_0.oga", placeholder: "<media:audio>" }),
    );
  });

  it.each(["voice", "photo", "video"] as const)(
    "returns null for %s when getFile exhausts retries so message is not dropped",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

      const promise = resolveMedia(makeCtx(mediaField, getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
      await flushRetryTimers();
      const result = await promise;

      expect(getFile).toHaveBeenCalledTimes(3);
      expect(result).toBeNull();
    },
  );

  it("does not catch errors from fetchRemoteMedia (only getFile is retried)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });
    fetchRemoteMedia.mockRejectedValueOnce(new Error("download failed"));

    await expect(
      resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN),
    ).rejects.toThrow("download failed");

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry 'file is too big' error (400 Bad Request) and returns null", async () => {
    // Simulate Telegram Bot API error when file exceeds 20MB limit.
    const fileTooBigError = createFileTooBigError();
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMedia(makeCtx("video", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    // Should NOT retry - "file is too big" is a permanent error, not transient.
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("does not retry 'file is too big' GrammyError instances and returns null", async () => {
    const fileTooBigError = new GrammyError(
      "Call to 'getFile' failed!",
      { ok: false, error_code: 400, description: "Bad Request: file is too big" },
      "getFile",
      {},
    );
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMedia(makeCtx("video", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it.each(["audio", "voice"] as const)(
    "returns null for %s when file is too big",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(createFileTooBigError());

      const result = await resolveMedia(makeCtx(mediaField, getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

      expect(getFile).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    },
  );

  it("throws when getFile returns no file_path", async () => {
    const getFile = vi.fn().mockResolvedValue({});
    await expect(
      resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN),
    ).rejects.toThrow("Telegram getFile returned no file_path");
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("still retries transient errors even after encountering file too big in different call", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    // Should retry transient errors.
    expect(result).not.toBeNull();
  });
});

describe("resolveMedia original filename preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["document", "business-plan.docx"],
    ["audio", "meeting-recording.mp3"],
    ["video", "demo.mp4"],
  ] as const)(
    "passes msg.%s.file_name to saveMediaBuffer instead of server-side path",
    async (mediaField, originalName) => {
      const getFile = vi.fn().mockResolvedValue({ file_path: `documents/file_abc123xyz.pdf` });
      fetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("data"),
        contentType: "application/octet-stream",
        // Simulates what fetchRemoteMedia derives from the server-side URL path —
        // NOT the original user filename.
        fileName: "file_abc123xyz.pdf",
      });
      saveMediaBuffer.mockResolvedValue({ path: "/tmp/saved", contentType: "application/pdf" });

      await resolveMedia(makeCtx(mediaField, getFile, originalName), MAX_MEDIA_BYTES, BOT_TOKEN);

      // saveMediaBuffer must receive the original Telegram filename, not the server-side path.
      expect(saveMediaBuffer).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "inbound",
        MAX_MEDIA_BYTES,
        originalName,
      );
    },
  );

  it("falls back to server-derived name when file_name is absent (e.g. voice)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });
    fetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      fileName: "file_0.oga",
    });
    saveMediaBuffer.mockResolvedValue({ path: "/tmp/file_0.oga", contentType: "audio/ogg" });

    await resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    // Voice has no file_name; falls back to fetched.fileName from the server path.
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "inbound",
      MAX_MEDIA_BYTES,
      "file_0.oga",
    );
  });
});
