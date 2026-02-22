import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

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
    await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
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
    await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
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
    await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
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
