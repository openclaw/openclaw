// OpenAI-compatible speech provider tests cover speech request and file output.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSpeakerSelectionFallbackCompat } from "../../packages/speech-core/speaker.js";
import { createOpenAiCompatibleSpeechProvider } from "./openai-compatible-speech-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  readProviderBinaryResponseMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  readProviderBinaryResponseMock: vi.fn(async (response: Response, label: string) => {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType === "application/json" || contentType?.startsWith("text/")) {
      throw new Error(`${label}: malformed audio response`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`${label}: malformed audio response`);
    }
    return bytes;
  }),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://example.test/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  readProviderBinaryResponse: readProviderBinaryResponseMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("missing first mock call");
  }
  const [arg] = call;
  if (!arg || typeof arg !== "object") {
    throw new Error("missing first mock argument");
  }
  return arg as Record<string, unknown>;
}

describe("createOpenAiCompatibleSpeechProvider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    readProviderBinaryResponseMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("normalizes config with built-in base URL policies", () => {
    const provider = createOpenAiCompatibleSpeechProvider({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/api/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3", "pcm"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["mp3"],
      baseUrlPolicy: {
        kind: "canonical",
        aliases: ["https://example.test/v1"],
      },
    });

    expect(provider.defaultModel).toBe("demo-tts");
    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        timeoutMs: 30_000,
        rawConfig: {
          providers: {
            demo: {
              apiKey: "sk-demo",
              baseUrl: "https://example.test/v1/",
              modelId: "custom-tts",
              voiceId: "nova",
              speed: 1.25,
              responseFormat: " PCM ",
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "sk-demo",
      baseUrl: "https://example.test/api/v1",
      model: "custom-tts",
      voice: "nova",
      speed: 1.25,
      responseFormat: "pcm",
    });
  });

  it.each([
    {
      providerId: "openrouter",
      scenario: "speakerVoice before every legacy alias",
      voiceConfig: {
        speakerVoice: " af_sky ",
        speakerVoiceId: "canonical-id",
        voice: "legacy-voice",
        voiceId: "legacy-id",
      },
      expectedVoice: "af_sky",
    },
    {
      providerId: "deepinfra",
      scenario: "speakerVoiceId after a blank speakerVoice",
      voiceConfig: {
        speakerVoice: "  ",
        speakerVoiceId: " af_heart ",
        voice: "legacy-voice",
        voiceId: "legacy-id",
      },
      expectedVoice: "af_heart",
    },
    {
      providerId: "openrouter",
      scenario: "the shipped voice alias after blank canonical values",
      voiceConfig: {
        speakerVoice: "  ",
        speakerVoiceId: "  ",
        voice: " af_nova ",
        voiceId: "legacy-id",
      },
      expectedVoice: "af_nova",
    },
    {
      providerId: "deepinfra",
      scenario: "the shipped voiceId alias after a blank voice",
      voiceConfig: {
        speakerVoice: "  ",
        speakerVoiceId: "  ",
        voice: "  ",
        voiceId: " af_echo ",
      },
      expectedVoice: "af_echo",
    },
  ] as const)(
    "$providerId honors $scenario",
    async ({ providerId, voiceConfig, expectedVoice }) => {
      const providers = {
        openrouter: {
          label: "OpenRouter",
          model: "hexgrad/kokoro-82m",
          defaultVoice: "af_alloy",
          baseUrl: "https://openrouter.ai/api/v1",
          envKey: "OPENROUTER_API_KEY",
        },
        deepinfra: {
          label: "DeepInfra",
          model: "hexgrad/Kokoro-82M",
          defaultVoice: "af_bella",
          baseUrl: "https://api.deepinfra.com/v1/openai",
          envKey: "DEEPINFRA_API_KEY",
        },
      } as const;
      const fixture = providers[providerId];
      const provider = createOpenAiCompatibleSpeechProvider({
        id: providerId,
        label: fixture.label,
        autoSelectOrder: 40,
        models: [fixture.model],
        voices: [fixture.defaultVoice],
        defaultModel: fixture.model,
        defaultVoice: fixture.defaultVoice,
        defaultBaseUrl: fixture.baseUrl,
        envKey: fixture.envKey,
        responseFormats: ["mp3"],
        defaultResponseFormat: "mp3",
        voiceCompatibleResponseFormats: ["mp3"],
      });
      const providerConfig = { apiKey: "test-api-key", ...voiceConfig };
      const resolvedConfig = provider.resolveConfig?.({
        cfg: {} as never,
        timeoutMs: 1_000,
        rawConfig: { providers: { [providerId]: providerConfig } },
      });
      if (!resolvedConfig) {
        throw new Error("missing resolved speech config");
      }
      const talkConfig = provider.resolveTalkConfig?.({
        cfg: {} as never,
        baseTtsConfig: { providers: { [providerId]: { voice: "base-voice" } } },
        talkProviderConfig: withSpeakerSelectionFallbackCompat(providerConfig),
        timeoutMs: 1_000,
      });
      if (!talkConfig) {
        throw new Error("missing resolved Talk speech config");
      }

      postJsonRequestMock.mockImplementation(async () => ({
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        release: async () => {},
      }));
      for (const config of [providerConfig, resolvedConfig, talkConfig]) {
        await provider.synthesize({
          text: "Speak in the configured voice.",
          cfg: {} as never,
          providerConfig: config,
          target: "audio-file",
          timeoutMs: 1_000,
        });
      }

      const requestVoices = postJsonRequestMock.mock.calls.map(
        ([request]) => (request as { body: { voice: unknown } }).body.voice,
      );
      expect(requestVoices).toEqual([expectedVoice, expectedVoice, expectedVoice]);
      expect(resolvedConfig.voice).toBe(expectedVoice);
      expect(talkConfig.voice).toBe(expectedVoice);
    },
  );

  it("maps configured extra JSON body fields into synthesis requests", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider<{
      routing?: Record<string, unknown>;
    }>({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3", "opus"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["opus"],
      baseUrlPolicy: { kind: "trim-trailing-slash" },
      readExtraConfig: (raw) =>
        typeof raw?.routing === "object" && raw.routing !== null && !Array.isArray(raw.routing)
          ? { routing: raw.routing as Record<string, unknown> }
          : {},
      extraJsonBodyFields: [{ configKey: "routing", requestKey: "provider" }],
    });

    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
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
      target: "voice-note",
      timeoutMs: 1234,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    const httpConfigRequest = requireFirstMockArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigRequest.baseUrl).toBe("https://example.test/v1");
    expect(httpConfigRequest.defaultBaseUrl).toBe("https://example.test/v1");
    expect(httpConfigRequest.provider).toBe("demo");
    expect(httpConfigRequest.capability).toBe("audio");

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstMockArg(postJsonRequestMock);
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
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects JSON success bodies from TTS responses as malformed audio", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: "not audio" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider({
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
    });

    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig: {},
        target: "voice-note",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Demo TTS API error: malformed audio response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects empty successful TTS bodies as malformed audio", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array(), { status: 200 }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider({
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
    });

    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig: {},
        target: "voice-note",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Demo TTS API error: malformed audio response");
    expect(release).toHaveBeenCalledOnce();
  });
});
