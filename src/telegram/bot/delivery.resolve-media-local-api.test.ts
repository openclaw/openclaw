import type { Message } from "@grammyjs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const fetchRemoteMedia = vi.fn();
const readFileMock = vi.fn();
const detectMimeMock = vi.fn();
const validateLocalFilePathMock = vi.fn();

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
}));

vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
}));

vi.mock("../../media/mime.js", () => ({
  detectMime: (...args: unknown[]) => detectMimeMock(...args),
  isGifMedia: () => false,
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock("../../globals.js", () => ({
  danger: (s: string) => s,
  logVerbose: () => {},
}));

vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
}));

// Partially mock api-base: keep real helpers, override validateLocalFilePath.
vi.mock("../api-base.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    validateLocalFilePath: (...args: unknown[]) => validateLocalFilePathMock(...args),
  };
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { resolveMedia } = await import("./delivery.js");

function makeVoiceCtx(getFile: TelegramContext["getFile"]): TelegramContext {
  return {
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      voice: { file_id: "v1", duration: 5, file_unique_id: "u1" },
    } as Message,
    me: {
      id: 1,
      is_bot: true as const,
      first_name: "bot",
      username: "bot",
    } as TelegramContext["me"],
    getFile,
  };
}

describe("resolveMedia with local Bot API server", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
    readFileMock.mockReset();
    detectMimeMock.mockReset();
    validateLocalFilePathMock.mockReset();
  });

  it("reads file from disk when apiRoot is set and file_path is absolute", async () => {
    const absPath = "/var/lib/telegram-bot-api/botdata/file_0.oga";
    const getFile = vi.fn().mockResolvedValue({ file_path: absPath });
    const audioBuf = Buffer.from("audio-data");

    validateLocalFilePathMock.mockResolvedValueOnce(absPath);
    readFileMock.mockResolvedValueOnce(audioBuf);
    detectMimeMock.mockResolvedValueOnce("audio/ogg");
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/saved/file_0.oga",
      contentType: "audio/ogg",
    });

    const result = await resolveMedia(
      makeVoiceCtx(getFile),
      10_000_000,
      "tok123",
      undefined, // proxyFetch
      "http://localhost:8081", // apiRoot — explicit per-account
      "/var/lib/telegram-bot-api", // localApiDataDir
    );

    expect(validateLocalFilePathMock).toHaveBeenCalledWith(absPath, "/var/lib/telegram-bot-api");
    expect(readFileMock).toHaveBeenCalledWith(absPath);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ path: "/saved/file_0.oga", placeholder: "<media:audio>" }),
    );
  });

  it("rejects disk read when path escapes the allowed directory", async () => {
    const maliciousPath = "/etc/shadow";
    const getFile = vi.fn().mockResolvedValue({ file_path: maliciousPath });

    validateLocalFilePathMock.mockRejectedValueOnce(
      new Error("Local Bot API file path escapes allowed directory"),
    );

    await expect(
      resolveMedia(
        makeVoiceCtx(getFile),
        10_000_000,
        "tok123",
        undefined,
        "http://localhost:8081",
        "/var/lib/telegram-bot-api",
      ),
    ).rejects.toThrow("escapes allowed directory");

    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("fetches via HTTP with relaxed SSRF when apiRoot is set and file_path is relative", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });

    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      fileName: "file_0.oga",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/saved/file_0.oga",
      contentType: "audio/ogg",
    });

    await resolveMedia(
      makeVoiceCtx(getFile),
      10_000_000,
      "tok123",
      undefined,
      "http://localhost:8081",
    );

    expect(validateLocalFilePathMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:8081/file/bottok123/voice/file_0.oga",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    );
  });

  it("does NOT relax SSRF when apiRoot is not set (env-var only)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });

    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      fileName: "file_0.oga",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/saved/file_0.oga",
      contentType: "audio/ogg",
    });

    // No apiRoot passed — simulates env-var-only scenario.
    await resolveMedia(makeVoiceCtx(getFile), 10_000_000, "tok123");

    const callArgs = fetchRemoteMedia.mock.calls[0][0];
    expect(callArgs.ssrfPolicy).toBeUndefined();
  });

  it("does NOT read from disk when apiRoot is not set even if file_path is absolute", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/tmp/sneaky/path.oga" });

    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      fileName: "path.oga",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/saved/path.oga",
      contentType: "audio/ogg",
    });

    // No apiRoot — should use HTTP, not disk read.
    await resolveMedia(makeVoiceCtx(getFile), 10_000_000, "tok123");

    expect(validateLocalFilePathMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchRemoteMedia).toHaveBeenCalled();
  });
});
