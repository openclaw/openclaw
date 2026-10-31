import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTtsSystemPromptHint,
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  listSpeechVoices,
  prepareTtsRequest,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  setRuntimeConfigSnapshot,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeech,
  textToSpeechCore,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type SpeechListVoicesRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

const mockConfig = (providerConfig: Record<string, unknown>): OpenClawConfig => ({
  tts: { enabled: true, provider: "mock", providers: { mock: providerConfig } },
});
const expectVoiceMemo = (mediaExtension: string) =>
  expectTtsPayloadResult({
    channel: "voice-memo-chat",
    prefsName: `voice-memo-${mediaExtension}`,
    text: "A native voice memo.",
    target: "audio-file",
    audioAsVoice: true,
    mediaExtension,
    providerResult: {
      audioBuffer: Buffer.from("mp3"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    },
  });

describe("TTS runtime native voice-note routing", () => {
  it("speaks stripped code through the explicit textToSpeech conversion path", async () => {
    let mediaDir: string | undefined;
    try {
      const result = await textToSpeech({
        text: "```ts\nconst answer = 42;\n```",
        cfg: createTtsConfig("openclaw-speech-core-code-convert-test"),
      });

      expect(result.success).toBe(true);
      const request = requireFirstSynthesisRequest("explicit code conversion request");
      expect(request.text).toBe("const answer = 42;");
      mediaDir = result.audioPath ? path.dirname(result.audioPath) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("returns a normal TTS failure when audio persistence rejects", async () => {
    const result = await textToSpeechCore(
      {
        text: "Store this synthesized reply.",
        cfg: createTtsConfig("openclaw-speech-core-persistence-failure-test"),
      },
      async () => {
        throw new Error("Media exceeds configured limit");
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "TTS audio persistence failed",
      provider: "mock",
    });
  });

  afterEach(resetTtsRuntime);

  it("tells generic TTS guidance to defer to MEMORY voice-delivery instructions", () => {
    const hint = buildTtsSystemPromptHint(createTtsConfig("openclaw-speech-core-tts-hint-test"));

    expect(hint).toContain("Voice (TTS) is enabled.");
    expect(hint).toContain(
      "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    );
    expect(hint).toContain(
      "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
    );
  });

  it("prepares deep-merged surface config and directive inputs", async () => {
    const cfg = mockConfig({ model: "base-model", voiceSettings: { stability: 0.4 } });
    cfg.tts!.modelOverrides = { allowProvider: false };

    const prepared = await prepareTtsRequest({
      cfg,
      override: {
        modelOverrides: { allowProvider: true },
        providers: {
          mock: { voice: "surface-voice", voiceSettings: { speed: 1.1 } },
        },
      },
      text: "Hello [[tts:text]]Speak this instead[[/tts:text]] caller",
    });

    expect(prepared.cfg).not.toBe(cfg);
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "surface-voice",
      voiceSettings: { stability: 0.4, speed: 1.1 },
    });
    expect(prepared.cfg.tts?.modelOverrides?.allowProvider).toBe(true);
    expect(prepared.directives).toEqual({
      cleanedText: "Hello  caller",
      hasDirective: true,
      overrides: { ttsText: "Speak this instead" },
      ttsText: "Speak this instead",
      warnings: [],
    });
    expect(cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voiceSettings: { stability: 0.4 },
    });
  });

  it("sanitizes blocked override keys while preparing TTS config", async () => {
    const prepared = await prepareTtsRequest({
      cfg: mockConfig({ model: "base-model" }),
      override: JSON.parse(
        '{"__proto__":{"polluted":"top"},"providers":{"mock":{"voice":"safe","__proto__":{"polluted":"nested"}}}}',
      ) as TtsConfig,
      text: "[[tts:text]]Speak this instead[[/tts:text]]",
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(prepared.cfg.tts).not.toHaveProperty("polluted");
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "safe",
    });
    expect(prepared.directives).toMatchObject({ cleanedText: "", ttsText: "Speak this instead" });
  });

  it("pre-transcodes synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectVoiceMemo("caf");
    expect(transcodeAudioBufferMock).toHaveBeenCalledOnce();
    const transcodeRequest = requireRecord(
      requireFirstCallParam(transcodeAudioBufferMock.mock.calls as unknown[][], "transcode"),
      "transcode request",
    );
    expect(transcodeRequest).toMatchObject({ sourceExtension: "mp3", targetExtension: "caf" });
  });

  it("falls back to the original mp3 buffer when the host transcoder fails", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: false,
      reason: "transcoder-failed",
      detail: "exit-1",
    });
    // The original mp3 still satisfies the channel's voice-memo formats.
    await expectVoiceMemo("mp3");
  });

  it("uses the active runtime snapshot when source config still contains TTS SecretRefs", async () => {
    const sourceConfig = mockConfig({
      apiKey: { source: "exec", provider: "mockexec", id: "minimax/tts/apiKey" },
    });
    const runtimeConfig = mockConfig({ apiKey: "test-key" });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured: ({ providerConfig }) => providerConfig.apiKey === "test-key",
        resolveConfig: ({ rawConfig }) => {
          const providers = rawConfig.providers as Record<string, { apiKey?: unknown }> | undefined;
          return providers?.mock ?? {};
        },
      }),
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = await synthesizeSpeech({
      text: "Runtime snapshot TTS SecretRef",
      cfg: sourceConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireFirstSynthesisRequest("runtime snapshot synthesis request");
    expect(request.cfg).toBe(runtimeConfig);
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig.apiKey).toBe("test-key");
  });

  it("resolves voice listing aliases with the configured timeout", async () => {
    const listVoicesMock = vi.fn(async (_request: SpeechListVoicesRequest) => []);
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        aliases: ["mock-alias"],
        defaultTimeoutMs: 60_000,
        listVoices: listVoicesMock,
      }),
    ]);

    await listSpeechVoices({
      provider: "  MOCK-ALIAS  ",
      cfg: { tts: { enabled: true, provider: "mock", timeoutMs: 45_000 } },
    });

    expect(listVoicesMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
  });
});
