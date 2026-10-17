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
    installSpeechProviders([createMockSpeechProvider("mock", { models: ["mock-tts"] })]);
    const result = await synthesizeSpeech({
      text: "Use capped explicit timeout.",
      cfg: modelConfig(
        { primary: "mock/mock-tts", timeoutMs: Number.MAX_SAFE_INTEGER },
        { provider: "mock" },
      ),
      disableFallback: true,
    });
    expect(result.success).toBe(true);
    expect(requireFirstSynthesisRequest("capped timeout").timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it.each([
    ["voiceModel default", "openai", undefined, "gpt-4o-mini-tts"],
    ["explicit model alias", "openrouter", "explicit-model", "default-model"],
  ] as const)("uses %s ahead of provider defaults", async (_name, id, explicit, model) => {
    const selected = createMockSpeechProvider(id, {
      autoSelectOrder: 10,
      models: explicit ? [explicit, model] : [model],
      resolveConfig: ({ rawConfig }) => ({
        ...(explicit ? {} : { model: "provider-default-model", modelId: "provider-default-model" }),
        ...requireRecord(requireRecord(rawConfig.providers, "providers")[id], "provider config"),
      }),
    });
    installSpeechProviders(explicit ? [selected] : [createMockSpeechProvider(), selected]);
    const result = await synthesizeSpeech({
      text: "Use the configured voice model.",
      cfg: modelConfig(
        { primary: id + "/" + model, ...(explicit ? {} : { timeoutMs: 12_345 }) },
        {
          prefsPath: "/tmp/openclaw-speech-model-" + id + ".json",
          ...(explicit ? { provider: id, providers: { [id]: { modelId: explicit } } } : {}),
        },
      ),
      disableFallback: true,
    });
    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("model selection");
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig).toMatchObject({ modelId: explicit ?? model });
    if (explicit) {
      expect(providerConfig.model).toBeUndefined();
    } else {
      expect(result).toMatchObject({ provider: id, providerModel: model });
      expect(providerConfig.model).toBe(model);
      expect(request.timeoutMs).toBe(12_345);
    }
  });

  it.each([false, true])(
    "tries voiceModel fallbacks before auto selection (same provider: %s)",
    async (same) => {
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
      const primary = same ? "bad-tts" : "gpt-4o-mini-tts";
      const fallbackId = same ? "openai" : "elevenlabs";
      const fallbackModel = same ? "good-tts" : "eleven_multilingual_v2";
      installSpeechProviders(
        same
          ? [
              createMockSpeechProvider("openai", {
                autoSelectOrder: 10,
                models: [primary, fallbackModel],
                synthesize,
              }),
            ]
          : [
              createMockSpeechProvider(),
              createMockSpeechProvider("openai", {
                autoSelectOrder: 10,
                models: [primary],
                isConfigured: () => false,
              }),
              createMockSpeechProvider(fallbackId, {
                autoSelectOrder: 99,
                models: [fallbackModel],
              }),
            ],
      );
      const result = await synthesizeSpeech({
        text: "Use the configured fallback model.",
        cfg: modelConfig(
          { primary: "openai/" + primary, fallbacks: [fallbackId + "/" + fallbackModel] },
          { prefsPath: "/tmp/openclaw-speech-model-fallback-" + same + ".json" },
        ),
      });
      expect(result).toMatchObject({
        success: true,
        provider: fallbackId,
        providerModel: fallbackModel,
      });
      if (same) {
        expect(result.attemptedProviders).toEqual(["openai", "openai"]);
        expect(synthesize.mock.calls.map(([request]) => request.providerConfig.model)).toEqual([
          "bad-tts",
          "good-tts",
        ]);
      } else {
        expect(result.fallbackFrom).toBe("openai");
      }
    },
  );

  it.each([false, true])(
    "falls back from a non-streaming provider or timeout (timeout: %s)",
    async (timeout) => {
      const release = vi.fn(async () => {});
      const fallback = vi.fn(async () => streamResult(timeout ? undefined : release));
      const primary = timeout ? "primary" : "buffered";
      const fallbackId = timeout ? "fallback" : "streaming";
      const timedOut = async () => {
        // This is the real transport error shape, not AbortError.
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      };
      installSpeechProviders([
        createMockSpeechProvider(primary, {
          autoSelectOrder: 1,
          ...(timeout ? { streamSynthesize: timedOut } : {}),
        }),
        createMockSpeechProvider(fallbackId, { autoSelectOrder: 2, streamSynthesize: fallback }),
      ]);
      const result = await textToSpeechStream({
        text: "## Keep [streaming Markdown](https://example.com) raw!!!!!",
        cfg: {
          tts: {
            enabled: true,
            provider: primary,
            prefsPath: "/tmp/openclaw-speech-stream-" + timeout + ".json",
          },
        },
      });
      expect(result).toMatchObject({ success: true, provider: fallbackId, fallbackFrom: primary });
      expect(requireAttempt(result.attempts, 0)).toMatchObject(
        timeout
          ? {
              provider: primary,
              outcome: "failed",
              reasonCode: "timeout",
              error: "primary: request timed out",
            }
          : {
              provider: primary,
              outcome: "skipped",
              reasonCode: "unsupported_for_streaming",
              personaBinding: "none",
              error: "buffered does not support streaming TTS",
            },
      );
      expect(requireAttempt(result.attempts, 1)).toMatchObject({
        provider: fallbackId,
        outcome: "success",
        reasonCode: "success",
      });
      if (timeout) {
        expect(fallback).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Keep streaming Markdown raw!" }),
        );
      } else {
        expect(result).toMatchObject({
          attemptedProviders: ["buffered", "streaming"],
          outputFormat: "pcm",
          fileExtension: ".pcm",
          target: "audio-file",
        });
        expect(requireAttempt(result.attempts, 0)).not.toHaveProperty("latencyMs");
        expect(fallback).toHaveBeenCalledOnce();
      }
      await result.release?.();
      if (!timeout) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );
});
