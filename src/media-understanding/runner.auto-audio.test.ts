import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

async function withAudioFixture(
  _name: string,
  run: (params: {
    ctx: MsgContext;
    media: ReturnType<typeof normalizeMediaAttachments>;
    cache: ReturnType<typeof createMediaAttachmentCache>;
  }) => Promise<void>,
) {
  const originalPath = process.env.PATH;
  if (process.platform !== "win32") {
    process.env.PATH = "/usr/bin:/bin";
  }
  const tmpPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-auto-audio-${Date.now()}.wav`,
  );
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

async function runAutoAudioCase(params: {
  transcribeAudio: (req: { model?: string }) => Promise<{ text: string; model: string }>;
  cfgExtra?: Partial<OpenClawConfig>;
}) {
  let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
    const providerRegistry = createOpenAiAudioProvider(params.transcribeAudio);
    const cfg = createOpenAiAudioCfg(params.cfgExtra);
    try {
      runResult = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
    } catch (err) {
      console.error(`[DEBUG] runCapability failed:`, err);
      throw err;
    }
  });
  if (!runResult) {
    throw new Error(
      `Expected auto audio case result for ${params.cfgExtra ? JSON.stringify(params.cfgExtra) : "default"}`,
    );
  }
  return runResult;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
    });
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("gpt-4o-mini-transcribe");
    expect(result.decision.outcome).toBe("success");
  });

  it("skips auto audio when disabled", async () => {
    const result = await runAutoAudioCase({
      transcribeAudio: async () => ({
        text: "ok",
        model: "whisper-1",
      }),
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("disabled");
  });

  it("prefers explicitly configured audio model entries", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", model: "whisper-1" }],
            },
          },
        },
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("whisper-1");
  });

  it("uses mistral when only mistral key is configured", async () => {
    const priorEnv: Record<string, string | undefined> = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.MISTRAL_API_KEY = "mistral-test-key";
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    try {
      await withAudioFixture("openclaw-auto-audio-mistral", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async () => ({ text: "openai", model: "gpt-4o-mini-transcribe" }),
          },
          mistral: {
            id: "mistral",
            capabilities: ["audio"],
            transcribeAudio: async (req) => ({ text: "mistral", model: req.model ?? "unknown" }),
          },
        });
        const cfg = {
          models: {
            providers: {
              mistral: {
                apiKey: "mistral-test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig;

        runResult = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });
      });
    } finally {
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    if (!runResult) {
      throw new Error("Expected auto audio mistral result");
    }
    expect(runResult.decision.outcome).toBe("success");
    expect(runResult.outputs[0]?.provider).toBe("mistral");
    expect(runResult.outputs[0]?.model).toBe("voxtral-mini-latest");
    expect(runResult.outputs[0]?.text).toBe("mistral");
  });
});
