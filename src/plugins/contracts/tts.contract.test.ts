import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { __testing as pluginLoaderTesting } from "../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { withEnv } from "../../test-utils/env.js";
import * as tts from "../../tts/tts.js";

let completeSimple: typeof import("@mariozechner/pi-ai").completeSimple;
let getApiKeyForModelMock: typeof import("../../agents/model-auth.js").getApiKeyForModel;
let requireApiKeyMock: typeof import("../../agents/model-auth.js").requireApiKey;
let resolveModelAsyncMock: typeof import("../../agents/pi-embedded-runner/model.js").resolveModelAsync;
let ensureCustomApiRegisteredMock: typeof import("../../agents/custom-api-registry.js").ensureCustomApiRegistered;
let prepareModelForSimpleCompletionMock: typeof import("../../agents/simple-completion-transport.js").prepareModelForSimpleCompletion;

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    completeSimple: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthProviders: () => [],
    getOAuthApiKey: vi.fn(async () => null),
  };
});

function createResolvedModel(provider: string, modelId: string, api = "openai-completions") {
  return {
    model: {
      provider,
      id: modelId,
      name: modelId,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  };
}

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) =>
    createResolvedModel(provider, modelId),
  ),
  resolveModelAsync: vi.fn(async (provider: string, modelId: string) =>
    createResolvedModel(provider, modelId),
  ),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

vi.mock("../../agents/custom-api-registry.js", () => ({
  ensureCustomApiRegistered: vi.fn(),
}));

const { _test, resolveTtsConfig, maybeApplyTtsToPayload, getTtsProvider } = tts;

const {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  getResolvedSpeechProviderConfig,
} = _test;

const mockAssistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

function createOpenAiTelephonyCfg(model: "tts-1" | "gpt-4o-mini-tts"): OpenClawConfig {
  return {
    messages: {
      tts: {
        provider: "openai",
        openai: {
          apiKey: "test-key",
          model,
          voice: "alloy",
          instructions: "Speak warmly",
        },
      },
    },
  };
}

function createAudioBuffer(length = 2): Buffer {
  return Buffer.from(new Uint8Array(length).fill(1));
}

function resolveBaseUrl(rawValue: unknown, fallback: string): string {
  return typeof rawValue === "string" && rawValue.trim() ? rawValue.replace(/\/+$/u, "") : fallback;
}

function buildTestOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => {
      const config = (rawConfig.openai ?? {}) as Record<string, unknown>;
      return {
        ...config,
        baseUrl: resolveBaseUrl(
          config.baseUrl ?? process.env.OPENAI_TTS_BASE_URL,
          "https://api.openai.com/v1",
        ),
      };
    },
    parseDirectiveToken: ({ key, value, providerConfig }) => {
      if (key === "voice") {
        const baseUrl = resolveBaseUrl(
          (providerConfig as Record<string, unknown> | undefined)?.baseUrl,
          "https://api.openai.com/v1",
        );
        const isDefaultEndpoint = baseUrl === "https://api.openai.com/v1";
        const allowedVoices = new Set([
          "alloy",
          "ash",
          "ballad",
          "coral",
          "echo",
          "sage",
          "shimmer",
          "verse",
        ]);
        if (isDefaultEndpoint && !allowedVoices.has(value)) {
          return { handled: true, warnings: [`invalid OpenAI voice "${value}"`] };
        }
        return { handled: true, overrides: { voice: value } };
      }
      if (key === "model") {
        const baseUrl = resolveBaseUrl(
          (providerConfig as Record<string, unknown> | undefined)?.baseUrl,
          "https://api.openai.com/v1",
        );
        const isDefaultEndpoint = baseUrl === "https://api.openai.com/v1";
        const allowedModels = new Set(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);
        if (isDefaultEndpoint && !allowedModels.has(value)) {
          return { handled: true, warnings: [`invalid OpenAI model "${value}"`] };
        }
        return { handled: true, overrides: { model: value } };
      }
      return { handled: false };
    },
    isConfigured: ({ providerConfig }) =>
      typeof (providerConfig as Record<string, unknown> | undefined)?.apiKey === "string" ||
      typeof process.env.OPENAI_API_KEY === "string",
    synthesize: async ({ text, providerConfig, providerOverrides }) => {
      const config = providerConfig as Record<string, unknown> | undefined;
      await fetch(`${resolveBaseUrl(config?.baseUrl, "https://api.openai.com/v1")}/audio/speech`, {
        method: "POST",
        body: JSON.stringify({
          input: text,
          model: providerOverrides?.model ?? config?.model ?? "gpt-4o-mini-tts",
          voice: providerOverrides?.voice ?? config?.voice ?? "alloy",
        }),
      });
      return {
        audioBuffer: createAudioBuffer(1),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: true,
      };
    },
    synthesizeTelephony: async ({ text, providerConfig }) => {
      const config = providerConfig as Record<string, unknown> | undefined;
      const configuredModel = typeof config?.model === "string" ? config.model : undefined;
      const model = configuredModel ?? "tts-1";
      const configuredInstructions =
        typeof config?.instructions === "string" ? config.instructions : undefined;
      const instructions =
        model === "gpt-4o-mini-tts" ? configuredInstructions || undefined : undefined;
      await fetch(`${resolveBaseUrl(config?.baseUrl, "https://api.openai.com/v1")}/audio/speech`, {
        method: "POST",
        body: JSON.stringify({
          input: text,
          model,
          voice: config?.voice ?? "alloy",
          instructions,
        }),
      });
      return {
        audioBuffer: createAudioBuffer(2),
        outputFormat: "mp3",
        sampleRate: 24000,
      };
    },
    listVoices: async () => [{ id: "alloy", label: "Alloy" }],
  };
}

function buildTestMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "microsoft",
    label: "Microsoft",
    aliases: ["edge"],
    autoSelectOrder: 30,
    resolveConfig: ({ rawConfig }) => {
      const edgeConfig = (rawConfig.edge ?? rawConfig.microsoft ?? {}) as Record<string, unknown>;
      return {
        ...edgeConfig,
        outputFormat: edgeConfig.outputFormat ?? "audio-24khz-48kbitrate-mono-mp3",
      };
    },
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    }),
    listVoices: async () => [{ id: "edge", label: "Edge" }],
  };
}

function buildTestElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    autoSelectOrder: 20,
    parseDirectiveToken: ({ key, value, currentOverrides }) => {
      if (key === "voiceid") {
        return { handled: true, overrides: { voiceId: value } };
      }
      if (key === "stability") {
        return {
          handled: true,
          overrides: {
            voiceSettings: {
              ...(currentOverrides as { voiceSettings?: Record<string, unknown> } | undefined)
                ?.voiceSettings,
              stability: Number(value),
            },
          },
        };
      }
      if (key === "speed") {
        return {
          handled: true,
          overrides: {
            voiceSettings: {
              ...(currentOverrides as { voiceSettings?: Record<string, unknown> } | undefined)
                ?.voiceSettings,
              speed: Number(value),
            },
          },
        };
      }
      return { handled: false };
    },
    isConfigured: ({ providerConfig }) =>
      typeof (providerConfig as Record<string, unknown> | undefined)?.apiKey === "string" ||
      typeof process.env.ELEVENLABS_API_KEY === "string" ||
      typeof process.env.XI_API_KEY === "string",
    synthesize: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    }),
    listVoices: async () => [{ id: "eleven", label: "Eleven" }],
  };
}

describe("tts", () => {
  beforeEach(async () => {
    ({ completeSimple } = await import("@mariozechner/pi-ai"));
    ({ getApiKeyForModel: getApiKeyForModelMock, requireApiKey: requireApiKeyMock } =
      await import("../../agents/model-auth.js"));
    ({ resolveModelAsync: resolveModelAsyncMock } =
      await import("../../agents/pi-embedded-runner/model.js"));
    ({ ensureCustomApiRegistered: ensureCustomApiRegisteredMock } =
      await import("../../agents/custom-api-registry.js"));
    prepareModelForSimpleCompletionMock = vi.fn(({ model }) => model);
    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      { pluginId: "openai", provider: buildTestOpenAISpeechProvider(), source: "test" },
      { pluginId: "microsoft", provider: buildTestMicrosoftSpeechProvider(), source: "test" },
      { pluginId: "elevenlabs", provider: buildTestElevenLabsSpeechProvider(), source: "test" },
    ];
    const { cacheKey } = pluginLoaderTesting.resolvePluginLoadCacheContext({ config: {} });
    setActivePluginRegistry(registry, cacheKey);
    vi.clearAllMocks();
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: "Summary" }]),
    );
  });

  describe("resolveEdgeOutputFormat", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it.each([
      {
        name: "default",
        cfg: baseCfg,
        expected: "audio-24khz-48kbitrate-mono-mp3",
      },
      {
        name: "override",
        cfg: {
          ...baseCfg,
          messages: {
            tts: {
              edge: { outputFormat: "audio-24khz-96kbitrate-mono-mp3" },
            },
          },
        } as OpenClawConfig,
        expected: "audio-24khz-96kbitrate-mono-mp3",
      },
    ] as const)("$name", ({ cfg, expected, name }) => {
      const config = resolveTtsConfig(cfg);
      const providerConfig = getResolvedSpeechProviderConfig(config, "microsoft") as {
        outputFormat?: string;
      };
      expect(providerConfig.outputFormat, name).toBe(expected);
    });
  });

  describe("parseTtsDirectives", () => {
    it("extracts overrides and strips directives when enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input =
        "Hello [[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1]] world\n\n" +
        "[[tts:text]](laughs) Read the song once more.[[/tts:text]]";
      const result = parseTtsDirectives(input, policy);
      const elevenlabsOverrides = result.overrides.providerOverrides?.elevenlabs as
        | {
            voiceId?: string;
            voiceSettings?: { stability?: number; speed?: number };
          }
        | undefined;

      expect(result.cleanedText).not.toContain("[[tts:");
      expect(result.ttsText).toBe("(laughs) Read the song once more.");
      expect(result.overrides.provider).toBe("elevenlabs");
      expect(elevenlabsOverrides?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
      expect(elevenlabsOverrides?.voiceSettings?.stability).toBe(0.4);
      expect(elevenlabsOverrides?.voiceSettings?.speed).toBe(1.1);
    });

    it("accepts edge as a legacy microsoft provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("edge");
    });

    it("rejects provider override by default while keeping voice overrides enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=edge voice=alloy]] world";
      const result = parseTtsDirectives(input, policy);
      const openaiOverrides = result.overrides.providerOverrides?.openai as
        | { voice?: string }
        | undefined;

      expect(result.overrides.provider).toBeUndefined();
      expect(openaiOverrides?.voice).toBe("alloy");
    });

    it("keeps text intact when overrides are disabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: false });
      const input = "Hello [[tts:voice=alloy]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).toBe(input);
      expect(result.overrides.provider).toBeUndefined();
    });

    it("accepts custom voices and models when openaiBaseUrl is a non-default endpoint", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:voice=kokoro-chinese model=kokoro-v1]] world";
      const result = parseTtsDirectives(input, policy, {
        providerConfigs: {
          openai: { baseUrl: "http://localhost:8880/v1" },
        },
      });
      const openaiOverrides = result.overrides.providerOverrides?.openai as
        | { voice?: string; model?: string }
        | undefined;

      expect(openaiOverrides?.voice).toBe("kokoro-chinese");
      expect(openaiOverrides?.model).toBe("kokoro-v1");
      expect(result.warnings).toHaveLength(0);
    });

    it("rejects unknown voices and models when openaiBaseUrl is the default OpenAI endpoint", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:voice=kokoro-chinese model=kokoro-v1]] world";
      const result = parseTtsDirectives(input, policy, {
        providerConfigs: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      });
      const openaiOverrides = result.overrides.providerOverrides?.openai as
        | { voice?: string }
        | undefined;

      expect(openaiOverrides?.voice).toBeUndefined();
      expect(result.warnings).toContain('invalid OpenAI voice "kokoro-chinese"');
    });
  });

  describe("summarizeText", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      const baseConfig = resolveTtsConfig(baseCfg);
      vi.mocked(completeSimple).mockResolvedValue(
        mockAssistantMessage([{ type: "text", text: mockSummary }]),
      );

      const longText = "A".repeat(2000);
      const result = await summarizeText(
        {
          text: longText,
          targetLength: 1500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        },
        {
          completeSimple,
          getApiKeyForModel: getApiKeyForModelMock,
          prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
          requireApiKey: requireApiKeyMock,
          resolveModelAsync: resolveModelAsyncMock,
        },
      );

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      const baseConfig = resolveTtsConfig(baseCfg);
      await summarizeText(
        {
          text: "Long text to summarize",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        },
        {
          completeSimple,
          getApiKeyForModel: getApiKeyForModelMock,
          prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
          requireApiKey: requireApiKeyMock,
          resolveModelAsync: resolveModelAsyncMock,
        },
      );

      const callArgs = vi.mocked(completeSimple).mock.calls[0];
      expect(callArgs?.[1]?.messages?.[0]?.role).toBe("user");
      expect(callArgs?.[2]?.maxTokens).toBe(250);
      expect(callArgs?.[2]?.temperature).toBe(0.3);
      expect(getApiKeyForModelMock).toHaveBeenCalledTimes(1);
    });

    it("uses summaryModel override when configured", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        messages: { tts: { summaryModel: "openai/gpt-4.1-mini" } },
      };
      const config = resolveTtsConfig(cfg);
      await summarizeText(
        {
          text: "Long text to summarize",
          targetLength: 500,
          cfg,
          config,
          timeoutMs: 30_000,
        },
        {
          completeSimple,
          getApiKeyForModel: getApiKeyForModelMock,
          prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
          requireApiKey: requireApiKeyMock,
          resolveModelAsync: resolveModelAsyncMock,
        },
      );

      expect(resolveModelAsyncMock).toHaveBeenCalledWith("openai", "gpt-4.1-mini", undefined, cfg);
    });

    it("keeps the Ollama api for direct summarization", async () => {
      const baseConfig = resolveTtsConfig(baseCfg);
      vi.mocked(resolveModelAsyncMock).mockResolvedValue({
        ...createResolvedModel("ollama", "qwen3:8b", "ollama"),
        model: {
          ...createResolvedModel("ollama", "qwen3:8b", "ollama").model,
          baseUrl: "http://127.0.0.1:11434",
        },
      } as never);

      await summarizeText(
        {
          text: "Long text to summarize",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        },
        {
          completeSimple,
          getApiKeyForModel: getApiKeyForModelMock,
          prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
          requireApiKey: requireApiKeyMock,
          resolveModelAsync: resolveModelAsyncMock,
        },
      );

      expect(vi.mocked(completeSimple).mock.calls[0]?.[0]?.api).toBe("ollama");
      expect(ensureCustomApiRegisteredMock).not.toHaveBeenCalled();
    });

    it.each([
      { targetLength: 99, shouldThrow: true },
      { targetLength: 100, shouldThrow: false },
      { targetLength: 10000, shouldThrow: false },
      { targetLength: 10001, shouldThrow: true },
    ] as const)("validates targetLength bounds: $targetLength", async (testCase) => {
      const baseConfig = resolveTtsConfig(baseCfg);
      const call = summarizeText(
        {
          text: "text",
          targetLength: testCase.targetLength,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        },
        {
          completeSimple,
          getApiKeyForModel: getApiKeyForModelMock,
          prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
          requireApiKey: requireApiKeyMock,
          resolveModelAsync: resolveModelAsyncMock,
        },
      );
      if (testCase.shouldThrow) {
        await expect(call, String(testCase.targetLength)).rejects.toThrow(
          `Invalid targetLength: ${testCase.targetLength}`,
        );
      } else {
        await expect(call, String(testCase.targetLength)).resolves.toBeDefined();
      }
    });

    it.each([
      { name: "no summary blocks", message: mockAssistantMessage([]) },
      {
        name: "empty summary content",
        message: mockAssistantMessage([{ type: "text", text: "   " }]),
      },
    ] as const)("throws when summary output is missing or empty: $name", async (testCase) => {
      const baseConfig = resolveTtsConfig(baseCfg);
      vi.mocked(completeSimple).mockResolvedValue(testCase.message);
      await expect(
        summarizeText(
          {
            text: "text",
            targetLength: 500,
            cfg: baseCfg,
            config: baseConfig,
            timeoutMs: 30_000,
          },
          {
            completeSimple,
            getApiKeyForModel: getApiKeyForModelMock,
            prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
            requireApiKey: requireApiKeyMock,
            resolveModelAsync: resolveModelAsyncMock,
          },
        ),
        testCase.name,
      ).rejects.toThrow("No summary returned");
    });
  });

  describe("getTtsProvider", () => {
    it.each([
      {
        name: "openai key available",
        env: {
          OPENAI_API_KEY: "test-openai-key",
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        prefsPath: "/tmp/tts-prefs-openai.json",
        expected: "openai",
      },
      {
        name: "elevenlabs key available",
        env: {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: "test-elevenlabs-key",
          XI_API_KEY: undefined,
        },
        prefsPath: "/tmp/tts-prefs-elevenlabs.json",
        expected: "elevenlabs",
      },
      {
        name: "falls back to microsoft",
        env: {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        prefsPath: "/tmp/tts-prefs-microsoft.json",
        expected: "microsoft",
      },
    ] as const)("selects provider based on available API keys: $name", (testCase) => {
      withEnv(testCase.env, () => {
        const config = {
          auto: "off",
          mode: "final",
          provider: "openai",
          providerSource: "default",
          summaryModel: undefined,
          modelOverrides: resolveModelOverridePolicy(undefined),
          providerConfigs: {
            openai: {},
            microsoft: {},
            elevenlabs: {},
          },
          prefsPath: undefined,
          maxTextLength: 4000,
          timeoutMs: 30_000,
        } as ReturnType<typeof resolveTtsConfig>;
        const provider = getTtsProvider(config, testCase.prefsPath);
        expect(provider).toBe(testCase.expected);
      });
    });
  });

  describe("resolveTtsConfig provider normalization", () => {
    it("normalizes legacy edge provider ids to microsoft", () => {
      const config = resolveTtsConfig({
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "edge",
            edge: {
              enabled: true,
            },
          },
        },
      });

      expect(config.provider).toBe("microsoft");
      expect(getTtsProvider(config, "/tmp/tts-prefs-normalized.json")).toBe("microsoft");
    });
  });

  describe("resolveTtsConfig – openai.baseUrl", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it.each([
      {
        name: "default endpoint",
        cfg: baseCfg,
        env: { OPENAI_TTS_BASE_URL: undefined },
        expected: "https://api.openai.com/v1",
      },
      {
        name: "env override",
        cfg: baseCfg,
        env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" },
        expected: "http://localhost:8880/v1",
      },
      {
        name: "config wins over env",
        cfg: {
          ...baseCfg,
          messages: {
            tts: { openai: { baseUrl: "http://my-server:9000/v1" } },
          },
        } as OpenClawConfig,
        env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" },
        expected: "http://my-server:9000/v1",
      },
      {
        name: "config slash trimming",
        cfg: {
          ...baseCfg,
          messages: {
            tts: { openai: { baseUrl: "http://my-server:9000/v1///" } },
          },
        } as OpenClawConfig,
        env: { OPENAI_TTS_BASE_URL: undefined },
        expected: "http://my-server:9000/v1",
      },
      {
        name: "env slash trimming",
        cfg: baseCfg,
        env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1/" },
        expected: "http://localhost:8880/v1",
      },
    ] as const)(
      "resolves openai.baseUrl from config/env with config precedence and slash trimming: $name",
      (testCase) => {
        withEnv(testCase.env, () => {
          const config = resolveTtsConfig(testCase.cfg);
          const openaiConfig = getResolvedSpeechProviderConfig(config, "openai") as {
            baseUrl?: string;
          };
          expect(openaiConfig.baseUrl, testCase.name).toBe(testCase.expected);
        });
      },
    );
  });

  describe("textToSpeechTelephony – openai instructions", () => {
    const withMockedTelephonyFetch = async (
      run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
    ) => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(2),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        await run(fetchMock);
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    async function expectTelephonyInstructions(
      model: "tts-1" | "gpt-4o-mini-tts",
      expectedInstructions: string | undefined,
    ) {
      await withMockedTelephonyFetch(async (fetchMock) => {
        const result = await tts.textToSpeechTelephony({
          text: "Hello there, friendly caller.",
          cfg: createOpenAiTelephonyCfg(model),
        });

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(typeof init.body).toBe("string");
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.instructions).toBe(expectedInstructions);
      });
    }

    it.each([
      { name: "tts-1 omits instructions", model: "tts-1", expectedInstructions: undefined },
      {
        name: "gpt-4o-mini-tts keeps instructions",
        model: "gpt-4o-mini-tts",
        expectedInstructions: "Speak warmly",
      },
    ] as const)(
      "only includes instructions for supported telephony models: $name",
      async (testCase) => {
        await expectTelephonyInstructions(testCase.model, testCase.expectedInstructions);
      },
    );
  });

  describe("maybeApplyTtsToPayload", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "inbound",
          provider: "openai",
          openai: { apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy" },
        },
      },
    };

    const withMockedAutoTtsFetch = async (
      run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
    ) => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        await run(fetchMock);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.OPENCLAW_TTS_PREFS = prevPrefs;
      }
    };

    const taggedCfg: OpenClawConfig = {
      ...baseCfg,
      messages: {
        ...baseCfg.messages!,
        tts: { ...baseCfg.messages!.tts, auto: "tagged" },
      },
    };

    it.each([
      {
        name: "inbound gating blocks non-audio",
        payload: { text: "Hello world" },
        inboundAudio: false,
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating blocks too-short cleaned text",
        payload: { text: "### **bold**" },
        inboundAudio: true,
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating allows audio with real text",
        payload: { text: "Hello world" },
        inboundAudio: true,
        expectedFetchCalls: 1,
        expectSamePayload: false,
      },
    ] as const)(
      "applies inbound auto-TTS gating by audio status and cleaned text length: $name",
      async (testCase) => {
        await withMockedAutoTtsFetch(async (fetchMock) => {
          const result = await maybeApplyTtsToPayload({
            payload: testCase.payload,
            cfg: baseCfg,
            kind: "final",
            inboundAudio: testCase.inboundAudio,
          });
          expect(fetchMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedFetchCalls);
          if (testCase.expectSamePayload) {
            expect(result, testCase.name).toBe(testCase.payload);
          } else {
            expect(result.mediaUrl, testCase.name).toBeDefined();
          }
        });
      },
    );

    it.each([
      {
        name: "plain text is skipped",
        payload: { text: "Hello world" },
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "tagged text is synthesized",
        payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
        expectedFetchCalls: 1,
        expectSamePayload: false,
      },
    ] as const)("respects tagged-mode auto-TTS gating: $name", async (testCase) => {
      await withMockedAutoTtsFetch(async (fetchMock) => {
        const result = await maybeApplyTtsToPayload({
          payload: testCase.payload,
          cfg: taggedCfg,
          kind: "final",
        });

        expect(fetchMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedFetchCalls);
        if (testCase.expectSamePayload) {
          expect(result, testCase.name).toBe(testCase.payload);
        } else {
          expect(result.mediaUrl, testCase.name).toBeDefined();
        }
      });
    });
  });
});
