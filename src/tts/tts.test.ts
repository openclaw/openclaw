import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureCustomApiRegistered } from "../agents/custom-api-registry.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import * as tts from "./tts.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    completeSimple: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(async () => null),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  })),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

vi.mock("../agents/custom-api-registry.js", () => ({
  ensureCustomApiRegistered: vi.fn(),
}));

const { _test, resolveTtsConfig, maybeApplyTtsToPayload, getTtsProvider } = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  isValidMinimaxModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  MINIMAX_TTS_MODELS,
  MINIMAX_TTS_VOICES,
  parseTtsDirectives,
  resolveOpenAITtsInstructions,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
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

describe("tts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: "Summary" }]),
    );
  });

  describe("isValidVoiceId", () => {
    it("validates ElevenLabs voice ID length and character rules", () => {
      const cases = [
        { value: "pMsXgVXv3BLzUgSXRplE", expected: true },
        { value: "21m00Tcm4TlvDq8ikWAM", expected: true },
        { value: "EXAVITQu4vr4xnSDxMaL", expected: true },
        { value: "a1b2c3d4e5", expected: true },
        { value: "a".repeat(40), expected: true },
        { value: "", expected: false },
        { value: "abc", expected: false },
        { value: "123456789", expected: false },
        { value: "a".repeat(41), expected: false },
        { value: "a".repeat(100), expected: false },
        { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
        { value: "pMsXgVXv3BLz_gSXRplE", expected: false },
        { value: "pMsXgVXv3BLz gSXRplE", expected: false },
        { value: "../../../etc/passwd", expected: false },
        { value: "voice?param=value", expected: false },
      ] as const;
      for (const testCase of cases) {
        expect(isValidVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
      }
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices including newer additions", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
      for (const newerVoice of ["ballad", "cedar", "juniper", "marin", "verse"]) {
        expect(isValidOpenAIVoice(newerVoice), newerVoice).toBe(true);
      }
    });

    it("rejects invalid voice names", () => {
      expect(isValidOpenAIVoice("invalid")).toBe(false);
      expect(isValidOpenAIVoice("")).toBe(false);
      expect(isValidOpenAIVoice("ALLOY")).toBe(false);
      expect(isValidOpenAIVoice("alloy ")).toBe(false);
      expect(isValidOpenAIVoice(" alloy")).toBe(false);
    });

    it("treats the default endpoint with trailing slash as the default endpoint", () => {
      expect(isValidOpenAIVoice("kokoro-custom-voice", "https://api.openai.com/v1/")).toBe(false);
    });
  });

  describe("isValidOpenAIModel", () => {
    it("matches the supported model set and rejects unsupported values", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toContain("tts-1");
      expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
      expect(OPENAI_TTS_MODELS).toHaveLength(3);
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
      const cases = [
        { model: "gpt-4o-mini-tts", expected: true },
        { model: "tts-1", expected: true },
        { model: "tts-1-hd", expected: true },
        { model: "invalid", expected: false },
        { model: "", expected: false },
        { model: "gpt-4", expected: false },
      ] as const;
      for (const testCase of cases) {
        expect(isValidOpenAIModel(testCase.model), testCase.model).toBe(testCase.expected);
      }
    });

    it("treats the default endpoint with trailing slash as the default endpoint", () => {
      expect(isValidOpenAIModel("kokoro-custom-model", "https://api.openai.com/v1/")).toBe(false);
    });
  });

  describe("resolveOpenAITtsInstructions", () => {
    it("keeps instructions only for gpt-4o-mini-tts variants", () => {
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", " Speak warmly ")).toBe(
        "Speak warmly",
      );
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts-2025-12-15", "Speak warmly")).toBe(
        "Speak warmly",
      );
      expect(resolveOpenAITtsInstructions("tts-1", "Speak warmly")).toBeUndefined();
      expect(resolveOpenAITtsInstructions("tts-1-hd", "Speak warmly")).toBeUndefined();
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", "   ")).toBeUndefined();
    });
  });

  describe("isValidMinimaxModel", () => {
    it("matches the supported MiniMax model set and rejects unsupported values", () => {
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.8-hd");
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.8-turbo");
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.6-hd");
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.6-turbo");
      expect(MINIMAX_TTS_MODELS).toContain("speech-02-hd");
      expect(MINIMAX_TTS_MODELS).toContain("speech-02-turbo");
      expect(MINIMAX_TTS_MODELS.length).toBeGreaterThan(0);

      const cases = [
        { model: "speech-2.8-hd", expected: true },
        { model: "speech-2.8-turbo", expected: true },
        { model: "speech-2.6-hd", expected: true },
        { model: "speech-02-hd", expected: true },
        { model: "invalid", expected: false },
        { model: "", expected: false },
        { model: "gpt-4o-mini-tts", expected: false },
      ] as const;
      for (const testCase of cases) {
        expect(isValidMinimaxModel(testCase.model), testCase.model).toBe(testCase.expected);
      }
    });
  });

  describe("MINIMAX_TTS_VOICES", () => {
    it("contains representative system voices", () => {
      expect(MINIMAX_TTS_VOICES.length).toBeGreaterThan(0);
      expect(MINIMAX_TTS_VOICES).toContain("English_expressive_narrator");
    });
  });

  describe("resolveOutputFormat", () => {
    it("selects opus for voice-bubble channels (telegram/feishu/whatsapp) and mp3 for others", () => {
      const cases = [
        {
          channel: "telegram",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            extension: ".opus",
            voiceCompatible: true,
          },
        },
        {
          channel: "feishu",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            extension: ".opus",
            voiceCompatible: true,
          },
        },
        {
          channel: "whatsapp",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            extension: ".opus",
            voiceCompatible: true,
          },
        },
        {
          channel: "discord",
          expected: {
            openai: "mp3",
            elevenlabs: "mp3_44100_128",
            extension: ".mp3",
            voiceCompatible: false,
          },
        },
      ] as const;
      for (const testCase of cases) {
        const output = resolveOutputFormat(testCase.channel);
        expect(output.openai, testCase.channel).toBe(testCase.expected.openai);
        expect(output.elevenlabs, testCase.channel).toBe(testCase.expected.elevenlabs);
        expect(output.extension, testCase.channel).toBe(testCase.expected.extension);
        expect(output.voiceCompatible, testCase.channel).toBe(testCase.expected.voiceCompatible);
      }
    });
  });

  describe("resolveEdgeOutputFormat", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("uses default edge output format unless overridden", () => {
      const cases = [
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
      ] as const;
      for (const testCase of cases) {
        const config = resolveTtsConfig(testCase.cfg);
        expect(resolveEdgeOutputFormat(config), testCase.name).toBe(testCase.expected);
      }
    });
  });

  describe("parseTtsDirectives", () => {
    it("extracts overrides and strips directives when enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input =
        "Hello [[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1]] world\n\n" +
        "[[tts:text]](laughs) Read the song once more.[[/tts:text]]";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).not.toContain("[[tts:");
      expect(result.ttsText).toBe("(laughs) Read the song once more.");
      expect(result.overrides.provider).toBe("elevenlabs");
      expect(result.overrides.elevenlabs?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
      expect(result.overrides.elevenlabs?.voiceSettings?.stability).toBe(0.4);
      expect(result.overrides.elevenlabs?.voiceSettings?.speed).toBe(1.1);
    });

    it("accepts edge as provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("edge");
    });

    it("accepts minimax as provider override and parses minimax directives", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input =
        "Hello [[tts:provider=minimax minimax_voice=English_radiant_girl emotion=happy speed=1.5 vol=7 pitch=-3 language_boost=en]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("minimax");
      expect(result.overrides.minimax?.voiceId).toBe("English_radiant_girl");
      expect(result.overrides.minimax?.emotion).toBe("happy");
      expect(result.overrides.minimax?.speed).toBe(1.5);
      expect(result.overrides.minimax?.vol).toBe(7);
      expect(result.overrides.minimax?.pitch).toBe(-3);
      expect(result.overrides.minimax?.languageBoost).toBe("en");
    });

    it("rejects out-of-range minimax vol and pitch directives", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:vol=15 pitch=20]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.minimax?.vol).toBeUndefined();
      expect(result.overrides.minimax?.pitch).toBeUndefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("rejects invalid minimax emotion and warns", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:emotion=joyful]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.minimax?.emotion).toBeUndefined();
      expect(result.warnings).toContain('invalid MiniMax emotion "joyful"');
    });

    it("parses minimax model via generic model directive", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:model=speech-2.8-hd]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.minimax?.model).toBe("speech-2.8-hd");
      expect(result.overrides.openai?.model).toBeUndefined();
    });

    it("rejects provider override by default while keeping voice overrides enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=edge voice=alloy]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBeUndefined();
      expect(result.overrides.openai?.voice).toBe("alloy");
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
      const customBaseUrl = "http://localhost:8880/v1";

      const result = parseTtsDirectives(input, policy, customBaseUrl);

      expect(result.overrides.openai?.voice).toBe("kokoro-chinese");
      expect(result.overrides.openai?.model).toBe("kokoro-v1");
      expect(result.warnings).toHaveLength(0);
    });

    it("rejects unknown voices and models when openaiBaseUrl is the default OpenAI endpoint", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:voice=kokoro-chinese model=kokoro-v1]] world";
      const defaultBaseUrl = "https://api.openai.com/v1";

      const result = parseTtsDirectives(input, policy, defaultBaseUrl);

      expect(result.overrides.openai?.voice).toBeUndefined();
      expect(result.warnings).toContain('invalid OpenAI voice "kokoro-chinese"');
    });
  });

  describe("resolveTtsConfig minimax", () => {
    it("resolves minimax defaults when no config is provided", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: { tts: {} },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.minimax.model).toBe("speech-2.8-hd");
      expect(config.minimax.voiceId).toBe("English_expressive_narrator");
      expect(config.minimax.speed).toBe(1.0);
      expect(config.minimax.vol).toBe(1.0);
      expect(config.minimax.pitch).toBe(0);
      expect(config.minimax.baseUrl).toBe("https://api.minimax.io");
    });

    it("respects explicit minimax config overrides", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "minimax",
            minimax: {
              model: "speech-2.8-turbo",
              voiceId: "English_CalmWoman",
              speed: 1.5,
              vol: 3,
              pitch: 2,
              emotion: "happy",
              languageBoost: "English",
            },
          },
        },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.provider).toBe("minimax");
      expect(config.minimax.model).toBe("speech-2.8-turbo");
      expect(config.minimax.voiceId).toBe("English_CalmWoman");
      expect(config.minimax.speed).toBe(1.5);
      expect(config.minimax.vol).toBe(3);
      expect(config.minimax.pitch).toBe(2);
      expect(config.minimax.emotion).toBe("happy");
      expect(config.minimax.languageBoost).toBe("English");
    });
  });

  describe("minimaxTTS hex validation", () => {
    const baseParams = {
      text: "hello",
      apiKey: "test-key",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      audioFormat: "mp3" as const,
      speed: 1,
      vol: 1,
      pitch: 0,
      timeoutMs: 5000,
    };

    it("rejects odd-length hex audio", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ base_resp: { status_code: 0 }, data: { audio: "abc" } }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as Response);

      await expect(tts.minimaxTTS(baseParams)).rejects.toThrow("malformed hex audio");
    });

    it("rejects non-hex characters in audio payload", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ base_resp: { status_code: 0 }, data: { audio: "zzzz" } }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as Response);

      await expect(tts.minimaxTTS(baseParams)).rejects.toThrow("malformed hex audio");
    });

    it("accepts valid hex audio", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ base_resp: { status_code: 0 }, data: { audio: "48454c4c4f" } }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as Response);

      const result = await tts.minimaxTTS(baseParams);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe("HELLO");
    });
  });

  describe("summarizeText", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };
    const baseConfig = resolveTtsConfig(baseCfg);

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      vi.mocked(completeSimple).mockResolvedValue(
        mockAssistantMessage([{ type: "text", text: mockSummary }]),
      );

      const longText = "A".repeat(2000);
      const result = await summarizeText({
        text: longText,
        targetLength: 1500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      const callArgs = vi.mocked(completeSimple).mock.calls[0];
      expect(callArgs?.[1]?.messages?.[0]?.role).toBe("user");
      expect(callArgs?.[2]?.maxTokens).toBe(250);
      expect(callArgs?.[2]?.temperature).toBe(0.3);
      expect(getApiKeyForModel).toHaveBeenCalledTimes(1);
    });

    it("uses summaryModel override when configured", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        messages: { tts: { summaryModel: "openai/gpt-4.1-mini" } },
      };
      const config = resolveTtsConfig(cfg);
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg,
        config,
        timeoutMs: 30_000,
      });

      expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4.1-mini", undefined, cfg);
    });

    it("registers the Ollama api before direct summarization", async () => {
      vi.mocked(resolveModel).mockReturnValue({
        model: {
          provider: "ollama",
          id: "qwen3:8b",
          name: "qwen3:8b",
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
        authStorage: { profiles: {} } as never,
        modelRegistry: { find: vi.fn() } as never,
      } as never);

      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", expect.any(Function));
    });

    it("validates targetLength bounds", async () => {
      const cases = [
        { targetLength: 99, shouldThrow: true },
        { targetLength: 100, shouldThrow: false },
        { targetLength: 10000, shouldThrow: false },
        { targetLength: 10001, shouldThrow: true },
      ] as const;
      for (const testCase of cases) {
        const call = summarizeText({
          text: "text",
          targetLength: testCase.targetLength,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        });
        if (testCase.shouldThrow) {
          await expect(call, String(testCase.targetLength)).rejects.toThrow(
            `Invalid targetLength: ${testCase.targetLength}`,
          );
        } else {
          await expect(call, String(testCase.targetLength)).resolves.toBeDefined();
        }
      }
    });

    it("throws when summary output is missing or empty", async () => {
      const cases = [
        { name: "no summary blocks", message: mockAssistantMessage([]) },
        {
          name: "empty summary content",
          message: mockAssistantMessage([{ type: "text", text: "   " }]),
        },
      ] as const;
      for (const testCase of cases) {
        vi.mocked(completeSimple).mockResolvedValue(testCase.message);
        await expect(
          summarizeText({
            text: "text",
            targetLength: 500,
            cfg: baseCfg,
            config: baseConfig,
            timeoutMs: 30_000,
          }),
          testCase.name,
        ).rejects.toThrow("No summary returned");
      }
    });
  });

  describe("getTtsProvider", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("selects provider based on available API keys", () => {
      const cases = [
        {
          env: {
            OPENAI_API_KEY: "test-openai-key",
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
            MINIMAX_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-openai.json",
          expected: "openai",
        },
        {
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: "test-elevenlabs-key",
            XI_API_KEY: undefined,
            MINIMAX_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-elevenlabs.json",
          expected: "elevenlabs",
        },
        {
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
            MINIMAX_API_KEY: "test-minimax-key",
          },
          prefsPath: "/tmp/tts-prefs-minimax.json",
          expected: "minimax",
        },
        {
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
            MINIMAX_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-edge.json",
          expected: "edge",
        },
      ] as const;

      for (const testCase of cases) {
        withEnv(testCase.env, () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, testCase.prefsPath);
          expect(provider).toBe(testCase.expected);
        });
      }
    });
  });

  describe("resolveTtsConfig – openai.baseUrl", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("defaults to the official OpenAI endpoint", () => {
      withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
        const config = resolveTtsConfig(baseCfg);
        expect(config.openai.baseUrl).toBe("https://api.openai.com/v1");
      });
    });

    it("picks up OPENAI_TTS_BASE_URL env var when no config baseUrl is set", () => {
      withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" }, () => {
        const config = resolveTtsConfig(baseCfg);
        expect(config.openai.baseUrl).toBe("http://localhost:8880/v1");
      });
    });

    it("config baseUrl takes precedence over env var", () => {
      const cfg: OpenClawConfig = {
        ...baseCfg,
        messages: {
          tts: { openai: { baseUrl: "http://my-server:9000/v1" } },
        },
      };
      withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" }, () => {
        const config = resolveTtsConfig(cfg);
        expect(config.openai.baseUrl).toBe("http://my-server:9000/v1");
      });
    });

    it("strips trailing slashes from the resolved baseUrl", () => {
      const cfg: OpenClawConfig = {
        ...baseCfg,
        messages: {
          tts: { openai: { baseUrl: "http://my-server:9000/v1///" } },
        },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.openai.baseUrl).toBe("http://my-server:9000/v1");
    });

    it("strips trailing slashes from env var baseUrl", () => {
      withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1/" }, () => {
        const config = resolveTtsConfig(baseCfg);
        expect(config.openai.baseUrl).toBe("http://localhost:8880/v1");
      });
    });
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

    it("omits instructions for unsupported speech models", async () => {
      await expectTelephonyInstructions("tts-1", undefined);
    });

    it("includes instructions for gpt-4o-mini-tts", async () => {
      await expectTelephonyInstructions("gpt-4o-mini-tts", "Speak warmly");
    });
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

    it("applies inbound auto-TTS gating by audio status and cleaned text length", async () => {
      const cases = [
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
      ] as const;

      for (const testCase of cases) {
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
      }
    });

    it("skips auto-TTS in tagged mode unless a tts tag is present", async () => {
      await withMockedAutoTtsFetch(async (fetchMock) => {
        const payload = { text: "Hello world" };
        const result = await maybeApplyTtsToPayload({
          payload,
          cfg: taggedCfg,
          kind: "final",
        });

        expect(result).toBe(payload);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    it("runs auto-TTS in tagged mode when tags are present", async () => {
      await withMockedAutoTtsFetch(async (fetchMock) => {
        const result = await maybeApplyTtsToPayload({
          payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
          cfg: taggedCfg,
          kind: "final",
        });

        expect(result.mediaUrl).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });
});
