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
  mediaField: "voice" | "audio" | "photo" | "video",
  getFile: TelegramContext["getFile"],
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
    msg.audio = { file_id: "a1", duration: 5, file_unique_id: "u2" };
  }
  if (mediaField === "photo") {
    msg.photo = [{ file_id: "p1", width: 100, height: 100 }];
  }
  if (mediaField === "video") {
    msg.video = { file_id: "vid1", duration: 10, file_unique_id: "u3" };
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

async function flushRetryTimers() {
  await vi.runAllTimersAsync();
}

describe("resolveMedia getFile retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries getFile on transient failure and succeeds on second attempt", async () => {
    const getFile = setupTransientGetFileRetry();
    const promise = resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
    await flushRetryTimers();
    const result = await promise;

    expect(getFile).toHaveBeenCalledTimes(2);
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
    // Simulate Telegram Bot API error when file exceeds 20MB limit
    const fileTooBigError = new Error(
      "GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)",
    );
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMedia(makeCtx("video", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    // Should NOT retry - "file is too big" is a permanent error, not transient
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
      const fileTooBigError = new Error(
        "GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)",
      );
      const getFile = vi.fn().mockRejectedValue(fileTooBigError);

      const result = await resolveMedia(makeCtx(mediaField, getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

      expect(getFile).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    },
  );

  it("still retries transient errors even after encountering file too big in different call", async () => {
    const getFile = setupTransientGetFileRetry();
    const promise = resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
    await flushRetryTimers();
    const result = await promise;

    // Should retry transient errors
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
  });
});
