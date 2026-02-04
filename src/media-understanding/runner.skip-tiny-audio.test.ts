import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

describe("runCapability skips tiny audio files", () => {
  it("skips audio transcription when file is smaller than MIN_AUDIO_FILE_BYTES", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    // Create a tiny audio file (well below the 1KB threshold)
    const tmpPath = path.join(os.tmpdir(), `openclaw-tiny-audio-${Date.now()}.wav`);
    const tinyBuffer = Buffer.alloc(100); // 100 bytes, way below 1024
    await fs.writeFile(tmpPath, tinyBuffer);

    const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/wav" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);

    let transcribeCalled = false;
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async (req) => {
          transcribeCalled = true;
          return { text: "should not happen", model: req.model };
        },
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "test-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      // The provider should never be called
      expect(transcribeCalled).toBe(false);

      // The result should indicate the attachment was skipped
      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      expect(result.decision.attachments[0].attempts).toHaveLength(1);
      expect(result.decision.attachments[0].attempts[0].outcome).toBe("skipped");
      expect(result.decision.attachments[0].attempts[0].reason).toContain("tooSmall");
    } finally {
      process.env.PATH = originalPath;
      await cache.cleanup();
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("skips audio transcription for empty (0-byte) files", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const tmpPath = path.join(os.tmpdir(), `openclaw-empty-audio-${Date.now()}.ogg`);
    await fs.writeFile(tmpPath, Buffer.alloc(0));

    const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/ogg" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);

    let transcribeCalled = false;
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async () => {
          transcribeCalled = true;
          return { text: "nope", model: "whisper-1" };
        },
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "test-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(transcribeCalled).toBe(false);
      expect(result.outputs).toHaveLength(0);
    } finally {
      process.env.PATH = originalPath;
      await cache.cleanup();
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("proceeds with transcription when file meets minimum size", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const tmpPath = path.join(os.tmpdir(), `openclaw-ok-audio-${Date.now()}.wav`);
    const okBuffer = Buffer.alloc(MIN_AUDIO_FILE_BYTES + 100);
    await fs.writeFile(tmpPath, okBuffer);

    const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/wav" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);

    let transcribeCalled = false;
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async (req) => {
          transcribeCalled = true;
          return { text: "hello world", model: req.model };
        },
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "test-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(transcribeCalled).toBe(true);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]?.text).toBe("hello world");
      expect(result.decision.outcome).toBe("success");
    } finally {
      process.env.PATH = originalPath;
      await cache.cleanup();
      await fs.unlink(tmpPath).catch(() => {});
    }
  });
});
