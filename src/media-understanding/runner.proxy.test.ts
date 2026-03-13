import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AudioTranscriptionRequest, VideoDescriptionRequest } from "./types.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";

async function runAudioCapabilityWithFetchCapture(params: {
  fixturePrefix: string;
  outputText: string;
}): Promise<typeof fetch | undefined> {
  let seenFetchFn: typeof fetch | undefined;
  await withAudioFixture(params.fixturePrefix, async ({ ctx, media, cache }) => {
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async (req: AudioTranscriptionRequest) => {
          seenFetchFn = req.fetchFn;
          return { text: params.outputText, model: req.model };
        },
      },
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "test-key", // pragma: allowlist secret
            models: [],
          },
        },
      },
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ provider: "openai", model: "whisper-1" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });

    expect(result.outputs[0]?.text).toBe(params.outputText);
  });
  return seenFetchFn;
}

describe("runCapability proxy fetch passthrough", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("passes fetchFn to audio provider when HTTPS_PROXY is set", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const seenFetchFn = await runAudioCapabilityWithFetchCapture({
      fixturePrefix: "openclaw-audio-proxy",
      outputText: "transcribed",
    });
    expect(seenFetchFn).toBeDefined();
    expect(seenFetchFn).not.toBe(globalThis.fetch);
  });

  it("passes fetchFn to video provider when HTTPS_PROXY is set", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await withVideoFixture("openclaw-video-proxy", async ({ ctx, media, cache }) => {
      let seenFetchFn: typeof fetch | undefined;

      const result = await runCapability({
        capability: "video",
        cfg: {
          models: {
            providers: {
              moonshot: {
                apiKey: "test-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
                models: [{ provider: "moonshot", model: "kimi-k2.5" }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map([
          [
            "moonshot",
            {
              id: "moonshot",
              capabilities: ["video"],
              describeVideo: async (req: VideoDescriptionRequest) => {
                seenFetchFn = req.fetchFn;
                return { text: "video ok", model: req.model };
              },
            },
          ],
        ]),
      });

      expect(result.outputs[0]?.text).toBe("video ok");
      expect(seenFetchFn).toBeDefined();
      expect(seenFetchFn).not.toBe(globalThis.fetch);
    });
  });

  it("does not pass fetchFn when no proxy env vars are set", async () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");

    const seenFetchFn = await runAudioCapabilityWithFetchCapture({
      fixturePrefix: "openclaw-audio-no-proxy",
      outputText: "ok",
    });
    expect(seenFetchFn).toBeUndefined();
  });
});
