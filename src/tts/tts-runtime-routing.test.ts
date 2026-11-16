import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderHttpError } from "../agents/provider-http-errors.js";
import {
  buildTtsSystemPromptHint,
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  listSpeechVoices,
  prepareTtsRequest,
  prefsPathFor,
  requireAttempt,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  setRuntimeConfigSnapshot,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeech,
  textToSpeechCore,
  textToSpeechStream,
  textToSpeechTelephony,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type SpeechListVoicesRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";
import * as ttsSettings from "./tts-settings.js";

const { resolveExplicitTtsOverridesAsync } = await import("./tts-request.js");

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

  it.each([
    { mode: "buffered", status: 429, code: "quota_exceeded" },
    { mode: "streaming", status: 503, code: "service_unavailable" },
    { mode: "telephony", status: 401, code: "invalid_api_key" },
  ])(
    "preserves HTTP failure classification in $mode TTS results",
    async ({ mode, status, code }) => {
      const error = await createProviderHttpError(
        new Response(JSON.stringify({ error: { code, message: "Synthetic speech failure" } }), {
          status,
          headers: { "Retry-After": "2", "x-request-id": "synthetic-request-id" },
        }),
        "Synthetic speech API",
      );
      const fail = vi.fn(async () => {
        throw error;
      });
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          synthesize: fail,
          streamSynthesize: fail,
          synthesizeTelephony: fail,
        }),
      ]);
      const params = {
        text: "Synthetic speech.",
        cfg: createTtsConfig("structured-failure-" + mode),
        prefsPath: prefsPathFor("structured-failure-" + mode),
      };
      const result = await (mode === "streaming"
        ? textToSpeechStream(params)
        : mode === "telephony"
          ? textToSpeechTelephony(params)
          : synthesizeSpeech(params));
      expect(result.success).toBe(false);
      const attempt = requireAttempt(result.attempts, 0);
      expect(attempt).toMatchObject({
        provider: "mock",
        outcome: "failed",
        reasonCode: "provider_error",
        status,
        errorCode: code,
        retryAfterMs: 2000,
      });
      for (const field of ["errorBody", "headers", "requestId", "cause", "stack"]) {
        expect(attempt).not.toHaveProperty(field);
      }
      expect(fail).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "keeps the original TTS failure with invalid metadata (getter: %s)",
    async (getter) => {
      const error = Object.assign(new Error("Synthetic original failure"), {
        errorCode: "not a machine code",
        status: "503",
        closeCode: 999,
        retryAfterMs: Infinity,
      });
      if (getter) {
        Object.defineProperty(error, "errorCode", {
          get() {
            throw new Error("Synthetic getter failure");
          },
        });
      }
      synthesizeMock.mockRejectedValueOnce(error);
      const result = await synthesizeSpeech({
        text: "Synthetic speech.",
        cfg: createTtsConfig("invalid-failure-metadata"),
        disableFallback: true,
      });
      expect(result.success).toBe(false);
      const attempt = requireAttempt(result.attempts, 0);
      expect(attempt).toMatchObject({
        error: "mock: Synthetic original failure",
        reasonCode: "provider_error",
      });
      for (const field of ["errorCode", "status", "closeCode", "retryAfterMs"]) {
        expect(attempt).not.toHaveProperty(field);
      }
    },
  );

  it("offers [[tts]] directive guidance only when model overrides are enabled", () => {
    const hint = (enabled: boolean) =>
      buildTtsSystemPromptHint(
        createTtsConfig("tts-hint", { auto: "inbound", modelOverrides: { enabled } }),
      )!.split("\n");
    expect(hint(true).filter((l) => l.includes("[[tts:"))).toEqual([
      "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
      "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
    ]);
    expect(hint(false)).toEqual(hint(true).filter((l) => !l.includes("[[tts:")));
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

  it("skips preference preparation for explicit providers and empty overrides", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        aliases: ["mock-alias"],
        resolveTalkOverrides: ({ params }) => ({ voice: params.voiceId }),
      }),
    ]);
    const cfg = { tts: { provider: "mock", prefsPath: prefsPathFor("unused-explicit-overrides") } };
    const preparePreferences = vi.spyOn(ttsSettings, "resolveTtsPrefsPathAsync");
    try {
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, modelId: " ", voiceId: " " }),
      ).resolves.toEqual({});
      await expect(
        resolveExplicitTtsOverridesAsync({
          cfg,
          provider: "  MOCK-ALIAS  ",
          voiceId: " voice-id ",
        }),
      ).resolves.toEqual({
        provider: "mock",
        providerOverrides: { mock: { voice: "voice-id" } },
      });
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, provider: " UNKNOWN " }),
      ).resolves.toEqual({
        provider: "unknown",
      });
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, provider: "unknown", voiceId: "voice-id" }),
      ).rejects.toThrow("speech provider unknown is not registered");
      expect(preparePreferences).not.toHaveBeenCalled();
    } finally {
      preparePreferences.mockRestore();
    }
  });

  it("prepares fallback preferences once and reads their current provider after preparation", async () => {
    const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "openclaw-explicit-overrides-"));
    const prefsPath = path.join(dir, "tts.json");
    const cfg = { tts: { provider: "previous", prefsPath } };
    installSpeechProviders([
      createMockSpeechProvider("previous"),
      createMockSpeechProvider("mock", {
        resolveTalkOverrides: ({ params }) => ({ voice: params.voiceId }),
      }),
    ]);
    writeFileSync(prefsPath, JSON.stringify({ tts: { provider: "previous" } }));
    const resolvePrefsPath = ttsSettings.resolveTtsPrefsPathAsync;
    const preparePreferences = vi
      .spyOn(ttsSettings, "resolveTtsPrefsPathAsync")
      .mockImplementation(async (...args) => {
        const preparedPath = await resolvePrefsPath(...args);
        writeFileSync(prefsPath, JSON.stringify({ tts: { provider: "mock" } }));
        return preparedPath;
      });
    try {
      await expect(resolveExplicitTtsOverridesAsync({ cfg, voiceId: "voice-id" })).resolves.toEqual(
        {
          provider: "mock",
          providerOverrides: { mock: { voice: "voice-id" } },
        },
      );
      expect(preparePreferences).toHaveBeenCalledOnce();
    } finally {
      preparePreferences.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-transcodes synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectVoiceMemo("caf");
    expect(transcodeAudioBufferMock).toHaveBeenCalledOnce();
    expect(transcodeAudioBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceExtension: "mp3", targetExtension: "caf" }),
    );
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
