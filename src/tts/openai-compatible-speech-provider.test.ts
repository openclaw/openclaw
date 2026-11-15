import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { mockFirstObjectArg } from "../test-utils/mock-call-assertions.js";
import { createOpenAiCompatibleSpeechProvider } from "./openai-compatible-speech-provider.js";
import type { SpeechSynthesisRequest } from "./provider-types.js";
import { withSpeakerSelectionCompat, withSpeakerSelectionFallbackCompat } from "./speaker.js";
import {
  getResolvedSpeechProviderConfig,
  resolveSpeechProviderTimeoutMs,
} from "./tts-provider-resolution.js";
import { resolveTtsConfig } from "./tts-settings.js";

const providerState = vi.hoisted(() => ({
  provider: undefined as SpeechProviderPlugin | undefined,
}));

vi.mock("./provider-registry.js", async () => {
  const { createSpeechProviderRegistry, normalizeSpeechProviderId } =
    await import("./provider-registry-core.js");
  return {
    ...createSpeechProviderRegistry({
      getProvider: () => providerState.provider,
      listProviders: () => (providerState.provider ? [providerState.provider] : []),
    }),
    normalizeSpeechProviderId,
  };
});

const { postJsonRequestMock, resolveProviderHttpRequestConfigMock } = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://example.test/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

// mock-isolation: Capture speech HTTP requests while retaining real response decoding, with no network access.
vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const { assertOkOrThrowHttpError, readProviderBinaryResponse } =
    await import("../agents/provider-http-errors.js");
  return {
    assertOkOrThrowHttpError,
    postJsonRequest: postJsonRequestMock,
    readProviderBinaryResponse,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  };
});

const demoOptions = {
  id: "demo",
  label: "Demo",
  autoSelectOrder: 40,
  models: ["demo-tts"],
  voices: ["alloy"],
  defaultModel: "demo-tts",
  defaultVoice: "alloy",
  defaultBaseUrl: "https://example.test/v1",
  envKey: "DEMO_API_KEY",
  responseFormats: ["mp3"],
  defaultResponseFormat: "mp3",
  voiceCompatibleResponseFormats: ["mp3"],
};

const defaultRequest = {
  text: "hello",
  cfg: {},
  providerConfig: {},
  target: "voice-note",
  timeoutMs: 1234,
} satisfies SpeechSynthesisRequest;

function mockAudioResponse(bytes = [4, 5, 6]) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(new Uint8Array(bytes), { status: 200 }),
    release,
  }));
  return release;
}

describe("createOpenAiCompatibleSpeechProvider", () => {
  afterEach(() => {
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    providerState.provider = undefined;
    vi.unstubAllEnvs();
  });

  it.each([
    ["global default", undefined, undefined, undefined, 30_000],
    ["provider default", 120_000, undefined, undefined, 120_000],
    ["explicit global-default value", 120_000, 30_000, undefined, 30_000],
    ["configured timeout", 120_000, 45_000, undefined, 45_000],
    ["per-call timeout", 120_000, 45_000, 5_000, 5_000],
  ] as const)(
    "uses the %s for the HTTP request",
    async (_name, defaultTimeoutMs, configured, perCall, expected) => {
      const provider = createOpenAiCompatibleSpeechProvider({ ...demoOptions, defaultTimeoutMs });
      const cfg = { tts: { timeoutMs: configured } };
      mockAudioResponse([1, 2, 3]);

      await provider.synthesize({
        ...defaultRequest,
        providerConfig: { apiKey: "test-key" },
        timeoutMs: resolveSpeechProviderTimeoutMs({
          config: resolveTtsConfig(cfg),
          provider,
          timeoutMs: perCall,
        }),
      });

      expect(mockFirstObjectArg(postJsonRequestMock).timeoutMs).toBe(expected);
    },
  );

  it.each([
    [{ speakerVoice: " a ", speakerVoiceId: "b", voice: "c", voiceId: "d" }, "a"],
    [{ speakerVoice: " ", speakerVoiceId: " b ", voice: "c" }, "b"],
    [{ speakerVoice: " ", speakerVoiceId: " ", voice: " c ", voiceId: "d" }, "c"],
    [{ speakerVoice: " ", speakerVoiceId: " ", voice: " ", voiceId: " d " }, "d"],
    [{}, "alloy"],
  ] as const)(
    "preserves %j as %s through direct, runtime, and Talk synthesis",
    async (selection, expected) => {
      const provider = createOpenAiCompatibleSpeechProvider(demoOptions);
      providerState.provider = provider;
      mockAudioResponse();
      const providerConfig = { apiKey: "test-key", ...selection };
      const rawConfig = { provider: "demo", providers: { demo: providerConfig } };
      const cfg = { tts: rawConfig };
      const resolved = getResolvedSpeechProviderConfig(resolveTtsConfig(cfg), "demo", cfg);
      const talkConfig = provider.resolveTalkConfig?.({
        cfg,
        baseTtsConfig: { providers: { demo: { apiKey: "test-key", voice: "base-voice" } } },
        talkProviderConfig: withSpeakerSelectionFallbackCompat(selection),
        timeoutMs: 1000,
      });
      const inheritedTalkConfig = provider.resolveTalkConfig?.({
        cfg,
        baseTtsConfig: { providers: { demo: withSpeakerSelectionCompat(providerConfig) } },
        talkProviderConfig: { speakerVoice: " ", speakerVoiceId: " ", voice: " ", voiceId: " " },
        timeoutMs: 1000,
      });
      for (const config of [
        providerConfig,
        resolved,
        expectDefined(talkConfig, "Talk provider config"),
        expectDefined(inheritedTalkConfig, "inherited Talk provider config"),
      ]) {
        await provider.synthesize({
          ...defaultRequest,
          providerConfig: config,
        });
      }
      expect(postJsonRequestMock.mock.calls.map(([request]) => request.body.voice)).toEqual([
        expected,
        expected,
        Object.keys(selection).length === 0 ? "base-voice" : expected,
        expected,
      ]);
      expect(providerConfig).toEqual({ apiKey: "test-key", ...selection });
    },
  );

  it("normalizes config with built-in base URL policies and preserves secret error paths", () => {
    const provider = createOpenAiCompatibleSpeechProvider({
      ...demoOptions,
      defaultBaseUrl: "https://example.test/api/v1",
      responseFormats: ["mp3", "pcm"],
      baseUrlPolicy: {
        kind: "canonical",
        aliases: ["https://example.test/v1"],
      },
    });

    const normalize = (demo: Record<string, unknown>) =>
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: { providers: { demo } },
        timeoutMs: 30_000,
      });
    expect(provider.defaultModel).toBe("demo-tts");
    expect(
      normalize({
        apiKey: "sk-demo",
        baseUrl: "https://example.test/v1/",
        modelId: "custom-tts",
        voiceId: "nova",
        speed: 1.25,
        responseFormat: " PCM ",
      }),
    ).toEqual({
      apiKey: "sk-demo",
      baseUrl: "https://example.test/api/v1",
      model: "custom-tts",
      voice: "nova",
      speed: 1.25,
      responseFormat: "pcm",
    });
    const apiKey = { source: "env", provider: "default", id: "UNRESOLVED_SPEECH_KEY" } as const;
    expect(() => normalize({ apiKey })).toThrow("tts.providers.demo.apiKey");
    expect(() =>
      provider.resolveTalkConfig?.({
        cfg: {},
        baseTtsConfig: {},
        talkProviderConfig: { apiKey },
        timeoutMs: 1000,
      }),
    ).toThrow("talk.providers.demo.apiKey");
  });

  it("maps configured extra JSON body fields into synthesis requests", async () => {
    const release = mockAudioResponse();
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider<{
      routing?: Record<string, unknown>;
    }>({
      ...demoOptions,
      responseFormats: ["mp3", "opus"],
      voiceCompatibleResponseFormats: ["opus"],
      baseUrlPolicy: { kind: "trim-trailing-slash" },
      readExtraConfig: (raw) => ({ routing: asOptionalRecord(raw?.routing) }),
      extraJsonBodyFields: [{ configKey: "routing", requestKey: "provider" }],
    });

    const result = await provider.synthesize({
      ...defaultRequest,
      providerConfig: {
        baseUrl: "https://example.test/v1/",
        responseFormat: "opus",
        routing: { order: ["openai"] },
      },
      providerOverrides: {
        modelId: "override-tts",
        voiceId: "verse",
        speed: 1.1,
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    const httpConfigRequest = mockFirstObjectArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigRequest).toMatchObject({
      baseUrl: "https://example.test/v1",
      defaultBaseUrl: "https://example.test/v1",
      provider: "demo",
      capability: "audio",
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = mockFirstObjectArg(postJsonRequestMock);
    expect(postRequest.url).toBe("https://example.test/v1/audio/speech");
    expect(postRequest.timeoutMs).toBe(1234);
    expect(postRequest.body).toStrictEqual({
      model: "override-tts",
      input: "hello",
      voice: "verse",
      response_format: "opus",
      speed: 1.1,
      provider: { order: ["openai"] },
    });
    expect(result.audioBuffer).toStrictEqual(Buffer.from([4, 5, 6]));
    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["JSON", "empty"])("rejects %s successful bodies as malformed audio", async (kind) => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        kind === "JSON" ? JSON.stringify({ error: "not audio" }) : new Uint8Array(),
        {
          status: 200,
          ...(kind === "JSON" ? { headers: { "content-type": "application/json" } } : {}),
        },
      ),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");
    const provider = createOpenAiCompatibleSpeechProvider(demoOptions);

    await expect(provider.synthesize(defaultRequest)).rejects.toThrow(
      "Demo TTS API error: malformed audio response",
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
