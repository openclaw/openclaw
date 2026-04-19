import { describe, expect, it, vi } from "vitest";
import type { SpeechSynthesisRequest } from "../provider-types.js";

vi.mock("../tts-core.js", () => ({
  openaiTTS: vi.fn().mockResolvedValue(Buffer.from("xai-audio")),
}));

import { openaiTTS } from "../tts-core.js";
import { buildXaiSpeechProvider } from "./xai.js";

describe("xAI speech provider bridge", () => {
  it("uses the OpenAI-compatible xAI endpoint", async () => {
    const provider = buildXaiSpeechProvider();
    const request = {
      text: "hello",
      cfg: {
        tts: {
          xai: {
            apiKey: "xai-key",
            baseUrl: "https://api.x.ai/v1/",
            model: "gpt-4o-mini-tts",
            voiceId: "alloy",
          },
        },
      },
      config: {
        xai: {
          apiKey: "xai-key",
          baseUrl: "https://api.x.ai/v1/",
          model: "gpt-4o-mini-tts",
          voiceId: "alloy",
          outputFormat: "mp3",
        },
        openai: {
          apiKey: undefined,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
        elevenlabs: {
          apiKey: undefined,
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "v",
          modelId: "m",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0,
            useSpeakerBoost: true,
            speed: 1,
          },
        },
        edge: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          saveSubtitles: false,
        },
        microsoft: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          saveSubtitles: false,
        },
        auto: "off",
        enabled: false,
        mode: "final",
        provider: "xai",
        modelOverrides: {},
        summaryModel: undefined,
        prefsPath: undefined,
        maxTextLength: 4096,
        timeoutMs: 30_000,
      },
      target: "audio-file",
    } as unknown as SpeechSynthesisRequest;
    const result = await provider.synthesize(request);
    expect(result.outputFormat).toBe("mp3");
    expect(openaiTTS).toHaveBeenCalled();
  });
});
