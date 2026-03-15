import { describe, expect, it } from "vitest";
import {
  formatExtensionHostTtsStatusText,
  resolveExtensionHostTtsStatusSnapshot,
  setExtensionHostLastTtsAttempt,
} from "./tts-status.js";

describe("tts-status", () => {
  it("builds a status snapshot from host-owned preferences and runtime state", () => {
    const config = {
      auto: "always",
      provider: "openai",
      providerSource: "config",
      prefsPath: "/tmp/tts-status.json",
      modelOverrides: {
        enabled: true,
        allowText: true,
        allowProvider: false,
        allowVoice: true,
        allowModelId: true,
        allowVoiceSettings: true,
        allowNormalization: true,
        allowSeed: true,
      },
      elevenlabs: {
        apiKey: undefined,
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice-id",
        modelId: "eleven_multilingual_v2",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0,
          useSpeakerBoost: true,
          speed: 1,
        },
      },
      openai: {
        apiKey: "openai-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: false,
        saveSubtitles: false,
      },
      mode: "final",
      maxTextLength: 4096,
      timeoutMs: 30000,
    };

    const status = resolveExtensionHostTtsStatusSnapshot({
      config,
      prefsPath: "/tmp/tts-status.json",
    });

    expect(status).toMatchObject({
      enabled: true,
      auto: "always",
      provider: "openai",
      providerConfigured: true,
      hasOpenAIKey: true,
      edgeEnabled: true,
      maxLength: 1500,
      summarize: true,
    });
    expect(status.fallbackProviders.length).toBeGreaterThan(0);
    expect(status.fallbackProviders).toContain(status.fallbackProvider);
  });

  it("formats the last attempt details in the host-owned status text", () => {
    setExtensionHostLastTtsAttempt({
      timestamp: 1000,
      success: false,
      textLength: 42,
      summarized: true,
      error: "provider failed",
    });

    const text = formatExtensionHostTtsStatusText(
      {
        enabled: true,
        auto: "always",
        provider: "openai",
        providerConfigured: true,
        fallbackProvider: "edge",
        fallbackProviders: ["edge"],
        prefsPath: "/tmp/tts-status.json",
        maxLength: 1500,
        summarize: true,
        hasOpenAIKey: true,
        hasElevenLabsKey: false,
        edgeEnabled: true,
        lastAttempt: {
          timestamp: 1000,
          success: false,
          textLength: 42,
          summarized: true,
          error: "provider failed",
        },
      },
      6000,
    );

    expect(text).toContain("📊 TTS status");
    expect(text).toContain("Last attempt (5s ago): ❌");
    expect(text).toContain("Text: 42 chars (summarized)");
    expect(text).toContain("Error: provider failed");

    setExtensionHostLastTtsAttempt(undefined);
  });
});
