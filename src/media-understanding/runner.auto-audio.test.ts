import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

async function withAudioFixture(
  run: (params: {
    ctx: MsgContext;
    media: ReturnType<typeof normalizeMediaAttachments>;
    cache: ReturnType<typeof createMediaAttachmentCache>;
  }) => Promise<void>,
) {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const tmpPath = path.join(os.tmpdir(), `openclaw-auto-audio-${Date.now()}.wav`);
  await fs.writeFile(tmpPath, Buffer.from("RIFF"));
  const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/wav" };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media);

  try {
    await run({ ctx, media, cache });
  } finally {
    process.env.PATH = originalPath;
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

function createOpenAiAudioProvider(
  transcribeAudio: (req: { model?: string }) => Promise<{ text: string; model: string }>,
) {
  return buildProviderRegistry({
    openai: {
      id: "openai",
      capabilities: ["audio"],
      transcribeAudio,
    },
  });
}

function createOpenAiAudioCfg(extra?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
    ...extra,
  } as unknown as OpenClawConfig;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    await withAudioFixture(async ({ ctx, media, cache }) => {
      let seenModel: string | undefined;
      const providerRegistry = createOpenAiAudioProvider(async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      });
      const cfg = createOpenAiAudioCfg();

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result.outputs[0]?.text).toBe("ok");
      expect(seenModel).toBe("gpt-4o-mini-transcribe");
      expect(result.decision.outcome).toBe("success");
    });
  });

  it("skips auto audio when disabled", async () => {
    await withAudioFixture(async ({ ctx, media, cache }) => {
      const providerRegistry = createOpenAiAudioProvider(async () => ({
        text: "ok",
        model: "whisper-1",
      }));
      const cfg = createOpenAiAudioCfg({
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("disabled");
    });
  });

  it("prefers explicitly configured audio model entries", async () => {
    await withAudioFixture(async ({ ctx, media, cache }) => {
      let seenModel: string | undefined;
      const providerRegistry = createOpenAiAudioProvider(async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      });
      const cfg = createOpenAiAudioCfg({
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", model: "whisper-1" }],
            },
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.outputs[0]?.text).toBe("ok");
      expect(seenModel).toBe("whisper-1");
    });
  });
});
