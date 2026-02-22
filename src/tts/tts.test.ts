import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import * as tts from "./tts.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
  // Some auth helpers import oauth provider metadata at module load time.
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

const {
  _test,
  resolveTtsConfig,
  maybeApplyTtsToPayload,
  getTtsProvider,
  resolveTtsApiKey,
  isTtsProviderConfigured,
} = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  isCustomOpenAIEndpoint,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
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
  });

  describe("resolveOutputFormat", () => {
    it("selects opus for Telegram and mp3 for other channels", () => {
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
          },
          prefsPath: "/tmp/tts-prefs-openai.json",
          expected: "openai",
        },
        {
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: "test-elevenlabs-key",
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-elevenlabs.json",
          expected: "elevenlabs",
        },
        {
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
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

  describe("OpenAI TTS baseUrl support", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    const restoreEnv = (snapshot: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
      const snapshot: Record<string, string | undefined> = {};
      for (const key of Object.keys(env)) {
        snapshot[key] = process.env[key];
      }
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        run();
      } finally {
        restoreEnv(snapshot);
      }
    };

    describe("resolveTtsConfig", () => {
      it("resolves openai.baseUrl from config", () => {
        const cfg = {
          ...baseCfg,
          messages: {
            tts: { openai: { baseUrl: "http://localhost:8880/v1" } },
          },
        };
        const config = resolveTtsConfig(cfg);
        expect(config.openai.baseUrl).toBe("http://localhost:8880/v1");
      });

      it("trims whitespace from baseUrl", () => {
        const cfg = {
          ...baseCfg,
          messages: {
            tts: { openai: { baseUrl: "  http://localhost:8880/v1  " } },
          },
        };
        const config = resolveTtsConfig(cfg);
        expect(config.openai.baseUrl).toBe("http://localhost:8880/v1");
      });

      it("leaves baseUrl undefined when not set", () => {
        const config = resolveTtsConfig(baseCfg);
        expect(config.openai.baseUrl).toBeUndefined();
      });
    });

    describe("isCustomOpenAIEndpoint", () => {
      it("returns true when config baseUrl is set", () => {
        withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
          expect(isCustomOpenAIEndpoint("http://localhost:8880/v1")).toBe(true);
        });
      });

      it("returns true when env var points to non-default URL", () => {
        withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" }, () => {
          expect(isCustomOpenAIEndpoint()).toBe(true);
        });
      });

      it("returns false when neither config nor env is set", () => {
        withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
          expect(isCustomOpenAIEndpoint()).toBe(false);
        });
      });
    });

    describe("resolveTtsApiKey", () => {
      it("returns 'local' sentinel when custom baseUrl is set with no API key", () => {
        withEnv({ OPENAI_API_KEY: undefined }, () => {
          const cfg = {
            ...baseCfg,
            messages: {
              tts: { openai: { baseUrl: "http://localhost:8880/v1" } },
            },
          };
          const config = resolveTtsConfig(cfg);
          expect(resolveTtsApiKey(config, "openai")).toBe("local");
        });
      });

      it("prefers real API key over sentinel", () => {
        withEnv({ OPENAI_API_KEY: "sk-real-key" }, () => {
          const cfg = {
            ...baseCfg,
            messages: {
              tts: { openai: { baseUrl: "http://localhost:8880/v1" } },
            },
          };
          const config = resolveTtsConfig(cfg);
          expect(resolveTtsApiKey(config, "openai")).toBe("sk-real-key");
        });
      });

      it("returns undefined for openai without key or baseUrl", () => {
        withEnv({ OPENAI_API_KEY: undefined }, () => {
          const config = resolveTtsConfig(baseCfg);
          expect(resolveTtsApiKey(config, "openai")).toBeUndefined();
        });
      });
    });

    describe("isTtsProviderConfigured", () => {
      it("returns true for openai with custom baseUrl and no API key", () => {
        withEnv({ OPENAI_API_KEY: undefined }, () => {
          const cfg = {
            ...baseCfg,
            messages: {
              tts: { openai: { baseUrl: "http://localhost:8880/v1" } },
            },
          };
          const config = resolveTtsConfig(cfg);
          expect(isTtsProviderConfigured(config, "openai")).toBe(true);
        });
      });

      it("returns false for openai without key or baseUrl", () => {
        withEnv({ OPENAI_API_KEY: undefined }, () => {
          const config = resolveTtsConfig(baseCfg);
          expect(isTtsProviderConfigured(config, "openai")).toBe(false);
        });
      });
    });

    describe("model/voice validation with custom baseUrl", () => {
      it("allows any model when config baseUrl is set", () => {
        expect(isValidOpenAIModel("chatterbox", "http://localhost:8880/v1")).toBe(true);
        expect(isValidOpenAIModel("coqui-xtts", "http://localhost:8880/v1")).toBe(true);
      });

      it("rejects unknown models without custom endpoint", () => {
        withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
          expect(isValidOpenAIModel("chatterbox")).toBe(false);
        });
      });

      it("allows any voice when config baseUrl is set", () => {
        expect(isValidOpenAIVoice("custom-voice", "http://localhost:8880/v1")).toBe(true);
      });

      it("rejects unknown voices without custom endpoint", () => {
        withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
          expect(isValidOpenAIVoice("custom-voice")).toBe(false);
        });
      });
    });
  });
});
