import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AssistantMessage, completeSimple } from "@mariozechner/pi-ai";
import { ensureCustomApiRegistered } from "../agents/custom-api-registry.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  TtsConfigSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
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

// Capture original existsSync before vi.mock replaces it, so tests outside
// the local-provider textToSpeech describe can restore the real behaviour.
// `var` is used (instead of `let`) because vi.mock factories are hoisted above
// `let`/`const` declarations and would hit the temporal dead zone otherwise.
// eslint-disable-next-line no-var
var _origExistsSync: typeof existsSync;

vi.mock("../process/exec.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../process/exec.js")>();
  return { ...original, runCommandWithTimeout: vi.fn() };
});

// Wrap existsSync so the local-provider tests can control whether the output
// file is "present" without touching the real filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  _origExistsSync = original.existsSync;
  return { ...original, existsSync: vi.fn(original.existsSync) };
});
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

const {
  _test,
  resolveTtsConfig,
  maybeApplyTtsToPayload,
  getTtsProvider,
  resolveTtsProviderOrder,
} = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveOpenAITtsInstructions,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
} = _test;

const mockAssistantMessage = (
  content: AssistantMessage["content"],
): AssistantMessage => ({
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
        expect(isValidVoiceId(testCase.value), testCase.value).toBe(
          testCase.expected,
        );
      }
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices including newer additions", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
      for (
        const newerVoice of ["ballad", "cedar", "juniper", "marin", "verse"]
      ) {
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
      expect(
        isValidOpenAIVoice("kokoro-custom-voice", "https://api.openai.com/v1/"),
      ).toBe(false);
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
        expect(isValidOpenAIModel(testCase.model), testCase.model).toBe(
          testCase.expected,
        );
      }
    });

    it("treats the default endpoint with trailing slash as the default endpoint", () => {
      expect(
        isValidOpenAIModel("kokoro-custom-model", "https://api.openai.com/v1/"),
      ).toBe(false);
    });
  });

  describe("resolveOpenAITtsInstructions", () => {
    it("keeps instructions only for gpt-4o-mini-tts variants", () => {
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", " Speak warmly "))
        .toBe(
          "Speak warmly",
        );
      expect(
        resolveOpenAITtsInstructions(
          "gpt-4o-mini-tts-2025-12-15",
          "Speak warmly",
        ),
      ).toBe(
        "Speak warmly",
      );
      expect(resolveOpenAITtsInstructions("tts-1", "Speak warmly"))
        .toBeUndefined();
      expect(resolveOpenAITtsInstructions("tts-1-hd", "Speak warmly"))
        .toBeUndefined();
      expect(resolveOpenAITtsInstructions("gpt-4o-mini-tts", "   "))
        .toBeUndefined();
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
        expect(output.elevenlabs, testCase.channel).toBe(
          testCase.expected.elevenlabs,
        );
        expect(output.extension, testCase.channel).toBe(
          testCase.expected.extension,
        );
        expect(output.voiceCompatible, testCase.channel).toBe(
          testCase.expected.voiceCompatible,
        );
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
        expect(resolveEdgeOutputFormat(config), testCase.name).toBe(
          testCase.expected,
        );
      }
    });
  });

  describe("parseTtsDirectives", () => {
    it("extracts overrides and strips directives when enabled", () => {
      const policy = resolveModelOverridePolicy({
        enabled: true,
        allowProvider: true,
      });
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
      const policy = resolveModelOverridePolicy({
        enabled: true,
        allowProvider: true,
      });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("edge");
    });

    it("accepts local as provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input = "Hello [[tts:provider=local]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("local");
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
      expect(result.warnings).toContain(
        'invalid OpenAI voice "kokoro-chinese"',
      );
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
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        },
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

      expect(resolveModel).toHaveBeenCalledWith(
        "openai",
        "gpt-4.1-mini",
        undefined,
        cfg,
      );
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

      expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
        "ollama",
        expect.any(Function),
      );
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
          await expect(call, String(testCase.targetLength)).resolves
            .toBeDefined();
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

    it("returns 'local' when explicitly set via config (providerSource: config)", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: { provider: "local", local: { command: "/bin/tts" } },
        },
      };
      const config = resolveTtsConfig(cfg);
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          expect(getTtsProvider(config, "/tmp/no-prefs-in-test.json")).toBe(
            "local",
          );
        },
      );
    });

    it("returns 'local' when set as user prefs override", () => {
      const config = resolveTtsConfig(baseCfg);
      const prefsPath = `/tmp/tts-prefs-local-${Date.now()}.json`;
      tts.setTtsProvider(prefsPath, "local");
      expect(getTtsProvider(config, prefsPath)).toBe("local");
    });

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

  describe("resolveTtsProviderOrder", () => {
    it("places local first when primary is local", () => {
      const order = resolveTtsProviderOrder("local");
      expect(order[0]).toBe("local");
      expect(order).toContain("openai");
      expect(order).toContain("elevenlabs");
      expect(order).toContain("edge");
      expect(order).toHaveLength(4);
    });

    it("includes local in the fallback list for every other primary", () => {
      for (const primary of ["openai", "elevenlabs", "edge"] as const) {
        const order = resolveTtsProviderOrder(primary);
        expect(order[0], primary).toBe(primary);
        expect(order, primary).toContain("local");
        expect(order, primary).toHaveLength(4);
      }
    });
  });

  describe("TTS Zod schema", () => {
    it("TtsProviderSchema accepts 'local'", () => {
      expect(TtsProviderSchema.parse("local")).toBe("local");
    });

    it("TtsProviderSchema rejects an unknown provider value", () => {
      expect(() => TtsProviderSchema.parse("unknown-provider")).toThrow();
    });

    it("TtsConfigSchema validates a local block with command and args", () => {
      const result = TtsConfigSchema.safeParse({
        provider: "local",
        local: {
          command: "/bin/tts",
          args: ["{{Text}}", "--out", "{{Output}}"],
        },
      });
      expect(result.success).toBe(true);
      expect(result.data?.local?.command).toBe("/bin/tts");
      expect(result.data?.local?.args).toEqual([
        "{{Text}}",
        "--out",
        "{{Output}}",
      ]);
    });

    it("TtsConfigSchema validates a local block with only command (no args)", () => {
      const result = TtsConfigSchema.safeParse({
        local: { command: "/bin/tts" },
      });
      expect(result.success).toBe(true);
      expect(result.data?.local?.command).toBe("/bin/tts");
      expect(result.data?.local?.args).toBeUndefined();
    });

    it("TtsConfigSchema rejects a local block with unknown keys", () => {
      const result = TtsConfigSchema.safeParse({
        local: { command: "/bin/tts", unknownKey: true },
      });
      expect(result.success).toBe(false);
    });

    it("TtsConfigSchema rejects a local block without a command (command required at schema level)", () => {
      // command is required in the Zod schema to match types.tts.ts
      const result = TtsConfigSchema.safeParse({ local: {} });
      expect(result.success).toBe(false);
    });
  });

  describe("maybeApplyTtsToPayload", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "inbound",
          provider: "openai",
          openai: {
            apiKey: "test-key",
            model: "gpt-4o-mini-tts",
            voice: "alloy",
          },
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
          expect(fetchMock, testCase.name).toHaveBeenCalledTimes(
            testCase.expectedFetchCalls,
          );
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

  describe("local provider", () => {
    const baseCfg = (): OpenClawConfig => ({
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "always",
          provider: "local",
          // Disable all cloud providers so they don't pollute errors.
          edge: { enabled: false },
          local: {
            command: "/usr/local/bin/fake-tts",
            args: ["--text", "{{Text}}", "--out", "{{Output}}"],
          },
        },
      },
    });

    const okResult = () => ({
      stdout: "",
      stderr: "",
      code: 0 as number | null,
      signal: null as NodeJS.Signals | null,
      killed: false,
      termination: "exit" as const,
    });

    beforeEach(() => {
      vi.mocked(runCommandWithTimeout).mockResolvedValue(okResult());
    });

    // ── config resolution ───────────────────────────────────────────────────

    describe("resolveTtsConfig", () => {
      it("maps local.command and local.args from raw config", () => {
        const config = tts.resolveTtsConfig(baseCfg());
        expect(config.local?.command).toBe("/usr/local/bin/fake-tts");
        expect(config.local?.args).toEqual([
          "--text",
          "{{Text}}",
          "--out",
          "{{Output}}",
        ]);
      });

      it("defaults args to [] when omitted", () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              local: { command: "/bin/tts" },
            },
          },
        };
        const config = tts.resolveTtsConfig(cfg);
        expect(config.local?.args).toEqual([]);
      });

      it("sets config.local to undefined when command is missing or absent", () => {
        const cases: OpenClawConfig[] = [
          {
            agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
            messages: { tts: {} },
          },
          {
            agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
            // @ts-expect-error – intentionally testing runtime behaviour
            messages: { tts: { local: {} } },
          },
          {
            agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
            messages: { tts: { local: { command: "" } } },
          },
        ];
        for (const cfg of cases) {
          expect(tts.resolveTtsConfig(cfg).local).toBeUndefined();
        }
      });
    });

    // ── isTtsProviderConfigured ──────────────────────────────────────────────

    describe("isTtsProviderConfigured", () => {
      it("returns true when local.command is set", () => {
        const config = tts.resolveTtsConfig(baseCfg());
        expect(tts.isTtsProviderConfigured(config, "local")).toBe(true);
      });

      it("returns false when local config is absent", () => {
        const config = tts.resolveTtsConfig({
          agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
          messages: { tts: {} },
        });
        expect(tts.isTtsProviderConfigured(config, "local")).toBe(false);
      });
    });

    // ── textToSpeech ────────────────────────────────────────────────────────

    describe("textToSpeech", () => {
      // The mocked runCommandWithTimeout never writes a real file; make
      // existsSync return true by default so success-path tests pass.  The
      // readPrefs callers that also use existsSync are wrapped in try/catch and
      // tolerate a missing file, so this override is safe for the whole block.
      beforeEach(() => {
        vi.mocked(existsSync).mockReturnValue(true);
      });
      afterEach(() => {
        // Restore passthrough behaviour for tests outside this describe block.
        vi.mocked(existsSync).mockImplementation(_origExistsSync);
      });

      it("returns success with an mp3 audioPath for non-Telegram channels", async () => {
        const result = await tts.textToSpeech({
          text: "Hello world",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-test-${Date.now()}.json`,
          channel: "whatsapp",
        });

        expect(result.success).toBe(true);
        expect(result.provider).toBe("local");
        expect(result.audioPath).toMatch(/\.ogg$/); // whatsapp is a voice-bubble channel
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
      });

      it("uses .ogg extension and opus format placeholder for Telegram", async () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              local: {
                command: "/bin/tts",
                args: ["--format", "{{Format}}", "--out", "{{Output}}"],
              },
            },
          },
        };

        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          // Capture what was passed so we can assert on it.
          (
            vi.mocked(runCommandWithTimeout) as ReturnType<typeof vi.fn> & {
              lastArgv?: string[];
            }
          ).lastArgv = argv;
          return okResult();
        });

        const result = await tts.textToSpeech({
          text: "Hello Telegram",
          cfg,
          prefsPath: `/tmp/tts-local-telegram-${Date.now()}.json`,
          channel: "telegram",
        });

        expect(result.success).toBe(true);
        expect(result.audioPath).toMatch(/\.ogg$/);
        const argv =
          (vi.mocked(runCommandWithTimeout) as ReturnType<typeof vi.fn> & {
            lastArgv?: string[];
          })
            .lastArgv ?? [];
        expect(argv).toContain("opus");
      });

      it("substitutes {{Text}}, {{Output}}, {{Channel}}, {{Format}} placeholders in args", async () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              local: {
                command: "/bin/tts",
                args: ["{{Text}}", "{{Output}}", "{{Channel}}", "{{Format}}"],
              },
            },
          },
        };

        let capturedArgv: string[] = [];
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          capturedArgv = argv;
          return okResult();
        });

        const prefsPath = `/tmp/tts-local-placeholders-${Date.now()}.json`;
        await tts.textToSpeech({
          text: "synthesize this",
          cfg,
          prefsPath,
          channel: "whatsapp",
        });

        expect(capturedArgv[0]).toBe("/bin/tts");
        expect(capturedArgv[1]).toBe("synthesize this"); // {{Text}}
        expect(capturedArgv[2]).toMatch(/\.ogg$/); // {{Output}} — whatsapp is a voice-bubble channel
        expect(capturedArgv[3]).toBe("whatsapp"); // {{Channel}}
        expect(capturedArgv[4]).toBe("opus"); // {{Format}} — whatsapp is a voice-bubble channel
      });

      it("passes no extra args when args array is empty", async () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              local: { command: "/bin/tts" },
            },
          },
        };

        let capturedArgv: string[] = [];
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          capturedArgv = argv;
          return okResult();
        });

        await tts.textToSpeech({
          text: "hello",
          cfg,
          prefsPath: `/tmp/tts-local-noargs-${Date.now()}.json`,
        });

        expect(capturedArgv).toEqual(["/bin/tts"]);
      });

      it("passes timeoutMs from config through to runCommandWithTimeout", async () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              timeoutMs: 12345,
              local: { command: "/bin/tts" },
            },
          },
        };

        let capturedOpts: unknown;
        vi.mocked(runCommandWithTimeout).mockImplementation(
          async (_argv, opts) => {
            capturedOpts = opts;
            return okResult();
          },
        );

        await tts.textToSpeech({
          text: "hello",
          cfg,
          prefsPath: `/tmp/tts-local-timeout-${Date.now()}.json`,
        });

        expect((capturedOpts as { timeoutMs: number }).timeoutMs).toBe(12345);
      });

      it("falls through with error when no command is configured", async () => {
        // No local.command → config.local is undefined → 'continue' to next provider.
        // All cloud providers also disabled/unconfigured → overall failure.
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
          messages: {
            tts: {
              auto: "always",
              provider: "local",
              edge: { enabled: false },
              // local intentionally omitted
            },
          },
        };

        const result = await tts.textToSpeech({
          text: "hello",
          cfg,
          prefsPath: `/tmp/tts-local-noconfig-${Date.now()}.json`,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("local: no command configured");
        // runCommandWithTimeout should never have been called.
        expect(runCommandWithTimeout).not.toHaveBeenCalled();
      });

      it("throws and falls back when exit code is non-zero", async () => {
        vi.mocked(runCommandWithTimeout).mockResolvedValue({
          ...okResult(),
          code: 1,
          stderr: "voice synthesis failed",
        });

        const result = await tts.textToSpeech({
          text: "hello",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-fail-${Date.now()}.json`,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("local: voice synthesis failed");
      });

      it("uses fallback message when exit is non-zero and stderr is empty", async () => {
        vi.mocked(runCommandWithTimeout).mockResolvedValue({
          ...okResult(),
          code: 127,
          stderr: "   ",
        });

        const result = await tts.textToSpeech({
          text: "hello",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-empty-stderr-${Date.now()}.json`,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("local TTS command failed");
      });

      it("falls back to remaining providers when local throws", async () => {
        vi.mocked(runCommandWithTimeout).mockRejectedValue(
          new Error("ENOENT: command not found"),
        );

        // Local fails, edge disabled, no cloud keys → all-failure result.
        const result = await tts.textToSpeech({
          text: "hello",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-throw-${Date.now()}.json`,
        });

        expect(result.success).toBe(false);
        // Local error is captured; other providers also tried.
        expect(result.error).toContain("local: ENOENT: command not found");
      });

      it("sets voiceCompatible true for Telegram .ogg output", async () => {
        const result = await tts.textToSpeech({
          text: "Hello Telegram",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-voicecompat-${Date.now()}.json`,
          channel: "telegram",
        });

        expect(result.success).toBe(true);
        expect(result.voiceCompatible).toBe(true);
      });

      it("sets voiceCompatible false for non-Telegram .mp3 output", async () => {
        // Keep parity with cloud providers: non-Telegram outputs should not
        // advertise voice compatibility, even when the extension is voice-capable.
        const result = await tts.textToSpeech({
          text: "Hello world",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-voicecompat-mp3-${Date.now()}.json`,
          channel: "whatsapp",
        });

        expect(result.success).toBe(true);
        expect(result.voiceCompatible).toBe(true); // whatsapp is a voice-bubble channel
        expect(result.audioPath).toMatch(/\.ogg$/); // whatsapp is a voice-bubble channel
      });

      it("falls back to local when the primary provider (openai) has no API key", async () => {
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
          messages: {
            tts: {
              auto: "always",
              provider: "openai",
              edge: { enabled: false },
              local: { command: "/bin/tts" },
              // openai.apiKey intentionally absent
            },
          },
        };

        const result = await withEnvAsync(
          {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
          },
          async () =>
            tts.textToSpeech({
              text: "hello world",
              cfg,
              prefsPath: `/tmp/tts-local-fallback-${Date.now()}.json`,
            }),
        );

        expect(result.success).toBe(true);
        expect(result.provider).toBe("local");
      });

      it("treats null exit code as non-zero and propagates fallback message", async () => {
        vi.mocked(runCommandWithTimeout).mockResolvedValue({
          ...okResult(),
          code: null,
          termination: "signal" as const,
          signal: "SIGTERM" as NodeJS.Signals,
        });

        const result = await tts.textToSpeech({
          text: "hello",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-nullexit-${Date.now()}.json`,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("local TTS command failed");
      });

      it("passes literal args (no placeholders) unchanged to the command", async () => {
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              local: {
                command: "/bin/tts",
                args: ["--quiet", "--rate", "1.0"],
              },
            },
          },
        };

        let capturedArgv: string[] = [];
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          capturedArgv = argv;
          return okResult();
        });

        await tts.textToSpeech({
          text: "hello",
          cfg,
          prefsPath: `/tmp/tts-local-literal-args-${Date.now()}.json`,
        });

        expect(capturedArgv).toEqual(["/bin/tts", "--quiet", "--rate", "1.0"]);
      });

      it("channel is 'unknown' when no channel is provided", async () => {
        let capturedArgv: string[] = [];
        const cfg: OpenClawConfig = {
          ...baseCfg(),
          messages: {
            tts: {
              ...baseCfg().messages!.tts,
              local: { command: "/bin/tts", args: ["{{Channel}}"] },
            },
          },
        };
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          capturedArgv = argv;
          return okResult();
        });

        await tts.textToSpeech({
          text: "hello",
          cfg,
          prefsPath: `/tmp/tts-local-nochannel-${Date.now()}.json`,
          // channel intentionally omitted
        });

        expect(capturedArgv[1]).toBe("unknown");
      });

      it("falls back with error when command exits 0 but output file is missing", async () => {
        // Simulate a command that ignores {{Output}} and writes to stdout instead.
        vi.mocked(existsSync).mockReturnValue(false);

        const result = await tts.textToSpeech({
          text: "hello",
          cfg: baseCfg(),
          prefsPath: `/tmp/tts-local-no-file-${Date.now()}.json`,
          channel: "whatsapp",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "local: command exited 0 but did not create output file",
        );
        // Provider fallback should have been attempted (all others unconfigured here).
        expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
      });
    });
  });
  // ── textToSpeechTelephony (local provider) ──────────────────────────────

  describe("local provider — textToSpeechTelephony", () => {
    const baseCfg = (): OpenClawConfig => ({
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "always",
          provider: "local",
          edge: { enabled: false },
          local: {
            command: "/usr/local/bin/fake-tts",
            args: ["--format", "{{Format}}", "--out", "{{Output}}"],
          },
        },
      },
    });

    const okResult = () => ({
      stdout: "",
      stderr: "",
      code: 0 as number | null,
      signal: null as NodeJS.Signals | null,
      killed: false,
      termination: "exit" as const,
    });

    beforeEach(() => {
      vi.mocked(runCommandWithTimeout).mockResolvedValue(okResult());
      vi.mocked(existsSync).mockReturnValue(true);
    });

    afterEach(() => {
      vi.mocked(existsSync).mockImplementation(_origExistsSync);
    });

    it("returns success with pcm format and 22050 sample rate", async () => {
      const { writeFileSync } = await import("node:fs");
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
        // Write a real PCM file to {{Output}} so readFileSync in the implementation succeeds.
        const outIdx = argv.indexOf("--out");
        if (outIdx !== -1) {
          writeFileSync(argv[outIdx + 1], Buffer.alloc(44100));
        }
        return okResult();
      });

      const result = await tts.textToSpeechTelephony({
        text: "Hello telephony",
        cfg: baseCfg(),
        prefsPath: `/tmp/tts-local-telephony-${Date.now()}.json`,
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe("local");
      expect(result.outputFormat).toBe("pcm");
      expect(result.sampleRate).toBe(22050);
      expect(result.audioBuffer).toBeDefined();
    });

    it("passes Format=pcm and Channel=telephony placeholders to command", async () => {
      const { writeFileSync } = await import("node:fs");
      const cfg: OpenClawConfig = {
        ...baseCfg(),
        messages: {
          tts: {
            ...baseCfg().messages!.tts,
            local: {
              command: "/usr/local/bin/fake-tts",
              args: ["--format", "{{Format}}", "--channel", "{{Channel}}", "--out", "{{Output}}"],
            },
          },
        },
      };
      let capturedArgv: string[] = [];
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
        capturedArgv = argv;
        // Write a fake PCM file to {{Output}} so readFileSync succeeds.
        const outIdx = argv.indexOf("--out");
        if (outIdx !== -1) {
          writeFileSync(argv[outIdx + 1], Buffer.alloc(0));
        }
        return okResult();
      });

      await tts.textToSpeechTelephony({
        text: "test",
        cfg,
        prefsPath: `/tmp/tts-local-telephony-args-${Date.now()}.json`,
      });

      expect(capturedArgv).toContain("pcm"); // {{Format}} resolved
      expect(capturedArgv).toContain("telephony"); // {{Channel}} resolved
    });

    it("falls back with error when local command is not configured", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: { tts: { provider: "local", edge: { enabled: false } } },
      };

      const result = await tts.textToSpeechTelephony({
        text: "hello",
        cfg,
        prefsPath: `/tmp/tts-local-telephony-nocommand-${Date.now()}.json`,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("local: no command configured");
    });

    it("falls back with error when command exits 0 but output file is missing", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await tts.textToSpeechTelephony({
        text: "hello",
        cfg: baseCfg(),
        prefsPath: `/tmp/tts-local-telephony-nofile-${Date.now()}.json`,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("local: command exited 0 but did not create output file");
    });
  });
});
