import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMER_TIMEOUT_MS,
  createMockSpeechProvider,
  installSpeechProviders,
  requireAttempt,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  synthesizeSpeech,
  textToSpeechStream,
  type OpenClawConfig,
  type SpeechSynthesisRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

function modelConfig(
  voiceModel: { primary: string; fallbacks?: string[]; timeoutMs?: number },
  tts: TtsConfig = {},
): OpenClawConfig {
  return { agents: { defaults: { voiceModel } }, tts: { enabled: true, ...tts } };
}

function streamResult(release?: () => Promise<void>) {
  return {
    audioStream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    fileExtension: ".pcm",
    outputFormat: "pcm",
    voiceCompatible: false,
    ...(release ? { release } : {}),
  };
}

describe("TTS runtime voice model and streaming behavior", () => {
  afterEach(resetTtsRuntime);

  it("caps oversized voice model TTS timeouts before synthesis", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1, models: ["mock-tts"] }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use capped explicit timeout.",
      cfg: modelConfig(
        { primary: "mock/mock-tts", timeoutMs: Number.MAX_SAFE_INTEGER },
        { provider: "mock" },
      ),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("voice model capped timeout request");
    expect(request.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("uses agents.defaults.voiceModel as the default speech provider and model", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["gpt-4o-mini-tts"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return {
            model: "provider-default-model",
            modelId: "provider-default-model",
            ...requireRecord(providers.openai, "raw openai provider config"),
          };
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use configured voice model.",
      cfg: modelConfig(
        { primary: "openai/gpt-4o-mini-tts", timeoutMs: 12_345 },
        { prefsPath: "/tmp/openclaw-speech-core-voice-model-default-test.json" },
      ),
      disableFallback: true,
    });

    expect(result).toMatchObject({
      success: true,
      provider: "openai",
      providerModel: "gpt-4o-mini-tts",
    });
    const request = requireFirstSynthesisRequest("voice model synthesis request");
    expect(request.providerConfig).toMatchObject({
      model: "gpt-4o-mini-tts",
      modelId: "gpt-4o-mini-tts",
    });
    expect(request.timeoutMs).toBe(12_345);
  });

  it("keeps explicit provider model aliases ahead of voiceModel defaults", async () => {
    installSpeechProviders([
      createMockSpeechProvider("openrouter", {
        models: ["explicit-model", "default-model"],
        resolveConfig: ({ rawConfig }) => {
          const providers = requireRecord(rawConfig.providers, "raw provider configs");
          return requireRecord(providers.openrouter, "raw openrouter provider config");
        },
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Prefer explicit model alias.",
      cfg: modelConfig(
        { primary: "openrouter/default-model" },
        {
          provider: "openrouter",
          prefsPath: "/tmp/openclaw-speech-core-explicit-model-alias-test.json",
          providers: { openrouter: { modelId: "explicit-model" } },
        },
      ),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("explicit model alias synthesis request");
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig).toMatchObject({
      modelId: "explicit-model",
    });
    expect(providerConfig.model).toBeUndefined();
  });

  it("tries voiceModel fallbacks before auto-selected speech providers", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["gpt-4o-mini-tts"],
        isConfigured: () => false,
      }),
      createMockSpeechProvider("elevenlabs", {
        autoSelectOrder: 99,
        models: ["eleven_multilingual_v2"],
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use configured voice model fallback.",
      cfg: modelConfig(
        {
          primary: "openai/gpt-4o-mini-tts",
          fallbacks: ["elevenlabs/eleven_multilingual_v2"],
        },
        { prefsPath: "/tmp/openclaw-speech-core-voice-model-fallback-test.json" },
      ),
    });

    expect(result).toMatchObject({
      success: true,
      provider: "elevenlabs",
      fallbackFrom: "openai",
      providerModel: "eleven_multilingual_v2",
    });
  });

  it("tries same-provider voiceModel fallbacks as separate model attempts", async () => {
    const synthesize = vi.fn(async (request: SpeechSynthesisRequest) => {
      if (request.providerConfig.model === "bad-tts") {
        throw new Error("unavailable model");
      }
      return {
        audioBuffer: Buffer.from("voice"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: request.target === "voice-note",
      };
    });
    installSpeechProviders([
      createMockSpeechProvider("openai", {
        autoSelectOrder: 10,
        models: ["bad-tts", "good-tts"],
        synthesize,
      }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use same-provider fallback model.",
      cfg: modelConfig(
        { primary: "openai/bad-tts", fallbacks: ["openai/good-tts"] },
        {
          prefsPath: "/tmp/openclaw-speech-core-same-provider-voice-model-fallback-test.json",
        },
      ),
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.providerModel).toBe("good-tts");
    expect(result.attemptedProviders).toEqual(["openai", "openai"]);
    expect(synthesize.mock.calls.map(([request]) => request.providerConfig.model)).toEqual([
      "bad-tts",
      "good-tts",
    ]);
  });

  it("skips non-streaming providers before using a streaming fallback", async () => {
    const release = vi.fn(async () => {});
    const streamSynthesize = vi.fn(async () => streamResult(release));
    installSpeechProviders([
      createMockSpeechProvider("buffered", { autoSelectOrder: 1 }),
      createMockSpeechProvider("streaming", {
        autoSelectOrder: 2,
        streamSynthesize,
      }),
    ]);

    const result = await textToSpeechStream({
      text: "Use streaming fallback.",
      cfg: {
        tts: {
          enabled: true,
          provider: "buffered",
          prefsPath: "/tmp/openclaw-speech-core-streaming-fallback-test.json",
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("streaming");
    expect(result.fallbackFrom).toBe("buffered");
    expect(result.attemptedProviders).toEqual(["buffered", "streaming"]);
    expect(result.outputFormat).toBe("pcm");
    expect(result.fileExtension).toBe(".pcm");
    expect(result.target).toBe("audio-file");
    await result.release?.();
    expect(release).toHaveBeenCalledOnce();
    const skippedAttempt = requireAttempt(result.attempts, 0);
    expect(skippedAttempt).toMatchObject({
      provider: "buffered",
      outcome: "skipped",
      reasonCode: "unsupported_for_streaming",
      personaBinding: "none",
      error: "buffered does not support streaming TTS",
    });
    expect(skippedAttempt).not.toHaveProperty("latencyMs");
    expect(requireAttempt(result.attempts, 1)).toMatchObject({
      provider: "streaming",
      outcome: "success",
      reasonCode: "success",
    });
    expect(streamSynthesize).toHaveBeenCalledOnce();
  });

  it("classifies streaming timeouts before falling back with normalized speech text", async () => {
    // Real transport timeouts arrive as "TimeoutError" (fetch-timeout.ts), not
    // AbortError; the classifier must catch the shape providers actually throw.
    const timeoutStreamSynthesize = vi.fn(async () => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    });
    const fallbackStreamSynthesize = vi.fn(async () => streamResult());
    installSpeechProviders([
      createMockSpeechProvider("primary", {
        autoSelectOrder: 1,
        streamSynthesize: timeoutStreamSynthesize,
      }),
      createMockSpeechProvider("fallback", {
        autoSelectOrder: 2,
        streamSynthesize: fallbackStreamSynthesize,
      }),
    ]);
    const text = "## Keep [streaming Markdown](https://example.com) raw!!!!!";

    const result = await textToSpeechStream({
      text,
      cfg: {
        tts: {
          enabled: true,
          provider: "primary",
          prefsPath: "/tmp/openclaw-speech-core-streaming-timeout-test.json",
        },
      } as OpenClawConfig,
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("fallback");
    expect(result.fallbackFrom).toBe("primary");
    expect(requireAttempt(result.attempts, 0)).toMatchObject({
      provider: "primary",
      outcome: "failed",
      reasonCode: "timeout",
      error: "primary: request timed out",
    });
    expect(requireAttempt(result.attempts, 1)).toMatchObject({
      provider: "fallback",
      outcome: "success",
      reasonCode: "success",
    });
    expect(fallbackStreamSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Keep streaming Markdown raw!" }),
    );
    await result.release?.();
  });
});
