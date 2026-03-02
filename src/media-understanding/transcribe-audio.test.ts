import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const {
  normalizeMediaAttachments,
  createMediaAttachmentCache,
  buildProviderRegistry,
  runCapability,
  cacheCleanup,
} = vi.hoisted(() => {
  const normalizeMediaAttachments = vi.fn();
  const cacheCleanup = vi.fn(async () => {});
  const createMediaAttachmentCache = vi.fn(() => ({ cleanup: cacheCleanup }));
  const buildProviderRegistry = vi.fn(() => new Map());
  const runCapability = vi.fn();
  return {
    normalizeMediaAttachments,
    createMediaAttachmentCache,
    buildProviderRegistry,
    runCapability,
    cacheCleanup,
  };
});

vi.mock("./runner.js", () => ({
  normalizeMediaAttachments,
  createMediaAttachmentCache,
  buildProviderRegistry,
  runCapability,
}));

import { transcribeAudioFile } from "./transcribe-audio.js";

describe("transcribeAudioFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheCleanup.mockResolvedValue(undefined);
  });

  it("does not force audio/wav when mime is omitted", async () => {
    normalizeMediaAttachments.mockReturnValue([{ index: 0, path: "/tmp/note.mp3" }]);
    runCapability.mockResolvedValue({
      outputs: [{ kind: "audio.transcription", text: "  hello  " }],
    });

    const result = await transcribeAudioFile({
      filePath: "/tmp/note.mp3",
      cfg: {} as OpenClawConfig,
    });

    expect(normalizeMediaAttachments).toHaveBeenCalledWith({
      MediaPath: "/tmp/note.mp3",
      MediaType: undefined,
    });
    expect(result).toEqual({ text: "hello" });
    expect(cacheCleanup).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and skips cache when there are no attachments", async () => {
    normalizeMediaAttachments.mockReturnValue([]);

    const result = await transcribeAudioFile({
      filePath: "/tmp/missing.wav",
      cfg: {} as OpenClawConfig,
    });

    expect(result).toEqual({ text: undefined });
    expect(createMediaAttachmentCache).not.toHaveBeenCalled();
    expect(runCapability).not.toHaveBeenCalled();
  });

  it("always cleans up cache on errors", async () => {
    const cfg = {
      tools: { media: { audio: { timeoutSeconds: 10 } } },
    } as unknown as OpenClawConfig;
    normalizeMediaAttachments.mockReturnValue([{ index: 0, path: "/tmp/note.wav" }]);
    runCapability.mockRejectedValue(new Error("boom"));

    await expect(
      transcribeAudioFile({
        filePath: "/tmp/note.wav",
        cfg,
      }),
    ).rejects.toThrow("boom");

    expect(runCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "audio",
        cfg,
        config: cfg.tools?.media?.audio,
      }),
    );
    expect(cacheCleanup).toHaveBeenCalledTimes(1);
  });
});
