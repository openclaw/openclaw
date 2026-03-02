import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  textToSpeechStream,
  textToSpeechWithFallback,
} = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  openaiTTS,
  openaiTTSReadable,
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

function getFetchRequestBody(fetchMock: { mock: { calls: unknown[][] } }, callIndex: number) {
  const call = fetchMock.mock.calls[callIndex] as [unknown, RequestInit | undefined] | undefined;
  const init = call?.[1];
  const body = init?.body;
  if (typeof body !== "string" || !body.trim()) {
    return {};
  }
  return JSON.parse(body) as Record<string, unknown>;
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
      withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
        expect(isValidOpenAIVoice("invalid")).toBe(false);
        expect(isValidOpenAIVoice("")).toBe(false);
        expect(isValidOpenAIVoice("ALLOY")).toBe(false);
        expect(isValidOpenAIVoice("alloy ")).toBe(false);
        expect(isValidOpenAIVoice(" alloy")).toBe(false);
      });
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
      withEnv({ OPENAI_TTS_BASE_URL: undefined }, () => {
        for (const testCase of cases) {
          expect(isValidOpenAIModel(testCase.model), testCase.model).toBe(testCase.expected);
        }
      });
    });
  });

  describe("resolveOutputFormat", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("selects opus for voice-bubble channels (telegram/feishu/whatsapp) and mp3 for others", () => {
      const config = resolveTtsConfig(baseCfg);
      const cases = [
        {
          channel: "telegram",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            openaiExtension: ".opus",
            openaiVoiceCompatible: true,
            elevenlabsVoiceCompatible: true,
          },
        },
        {
          channel: "feishu",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            openaiExtension: ".opus",
            openaiVoiceCompatible: true,
            elevenlabsVoiceCompatible: true,
          },
        },
        {
          channel: "whatsapp",
          expected: {
            openai: "opus",
            elevenlabs: "opus_48000_64",
            openaiExtension: ".opus",
            openaiVoiceCompatible: true,
            elevenlabsVoiceCompatible: true,
          },
        },
        {
          channel: "discord",
          expected: {
            openai: "mp3",
            elevenlabs: "mp3_44100_128",
            openaiExtension: ".mp3",
            openaiVoiceCompatible: false,
            elevenlabsVoiceCompatible: false,
          },
        },
      ] as const;
      for (const testCase of cases) {
        const output = resolveOutputFormat(config, testCase.channel);
        expect(output.openai, testCase.channel).toBe(testCase.expected.openai);
        expect(output.elevenlabs, testCase.channel).toBe(testCase.expected.elevenlabs);
        expect(output.openaiExtension, testCase.channel).toBe(testCase.expected.openaiExtension);
        expect(output.openaiVoiceCompatible, testCase.channel).toBe(
          testCase.expected.openaiVoiceCompatible,
        );
        expect(output.elevenlabsVoiceCompatible, testCase.channel).toBe(
          testCase.expected.elevenlabsVoiceCompatible,
        );
      }
    });

    it("respects configured openai.responseFormat over channel defaults", () => {
      const cfg: OpenClawConfig = {
        ...baseCfg,
        messages: {
          tts: {
            openai: {
              responseFormat: "flac",
            },
          },
        },
      };
      const config = resolveTtsConfig(cfg);
      const output = resolveOutputFormat(config, "telegram");
      expect(output.openai).toBe("flac");
      expect(output.openaiExtension).toBe(".flac");
      expect(output.openaiVoiceCompatible).toBe(false);
      expect(output.elevenlabsVoiceCompatible).toBe(true);
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
      const result = parseTtsDirectives(input, policy, {});

      expect(result.cleanedText).not.toContain("[[tts:");
      expect(result.ttsText).toBe("(laughs) Read the song once more.");
      expect(result.overrides.provider).toBe("elevenlabs");
      expect(result.overrides.elevenlabs?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
      expect(result.overrides.elevenlabs?.voiceSettings?.stability).toBe(0.4);
      expect(result.overrides.elevenlabs?.voiceSettings?.speed).toBe(1.1);
    });

    it("parses OpenAI instruction and stream directives when allowed", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:instructions=calm stream=on]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.openai?.instructions).toBe("calm");
      expect(result.overrides.openai?.stream).toBe(true);
    });

    it("parses multi-word instructions and stops at the next directive key", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:instructions=speak slowly and warmly stream=on]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.openai?.instructions).toBe("speak slowly and warmly");
      expect(result.overrides.openai?.stream).toBe(true);
    });

    it("parses OpenAI responseFormat/speed/streamFormat directives when allowed", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:responseFormat=wav openai_speed=1.75 streamFormat=audio]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.openai?.responseFormat).toBe("wav");
      expect(result.overrides.openai?.speed).toBe(1.75);
      expect(result.overrides.openai?.streamFormat).toBe("audio");
    });

    it("routes openai_model directives using configured custom openai baseUrl", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:openai_model=qwen3-tts]] world";

      const result = parseTtsDirectives(input, policy, {
        openaiBaseUrl: "http://localhost:8880/v1",
      });

      expect(result.overrides.openai?.model).toBe("qwen3-tts");
      expect(result.overrides.elevenlabs?.modelId).toBeUndefined();
    });

    it("routes explicit ElevenLabs model directives before OpenAI fallback on custom endpoints", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:model_id=eleven_multilingual_v2]] world";

      const result = parseTtsDirectives(input, policy, {
        openaiBaseUrl: "http://localhost:8880/v1",
      });

      expect(result.overrides.elevenlabs?.modelId).toBe("eleven_multilingual_v2");
      expect(result.overrides.openai?.model).toBeUndefined();
    });

    it("routes generic model directives to ElevenLabs when provider=elevenlabs", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input = "Hello [[tts:provider=elevenlabs model=eleven_multilingual_v2]] world";

      const result = parseTtsDirectives(input, policy, {
        openaiBaseUrl: "http://localhost:8880/v1",
      });

      expect(result.overrides.elevenlabs?.modelId).toBe("eleven_multilingual_v2");
      expect(result.overrides.openai?.model).toBeUndefined();
    });

    it("ignores provider hint for generic model routing when provider overrides are disabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=elevenlabs model=eleven_multilingual_v2]] world";

      const result = parseTtsDirectives(input, policy, {
        openaiBaseUrl: "http://localhost:8880/v1",
      });

      expect(result.overrides.provider).toBeUndefined();
      expect(result.overrides.openai?.model).toBe("eleven_multilingual_v2");
      expect(result.overrides.elevenlabs?.modelId).toBeUndefined();
    });

    it("routes voice directives using configured custom openai baseUrl", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:voice=ono_anna]] world";

      const result = parseTtsDirectives(input, policy, {
        openaiBaseUrl: "http://localhost:8880/v1",
      });

      expect(result.overrides.openai?.voice).toBe("ono_anna");
      expect(result.warnings).toEqual([]);
    });

    it("blocks instruction and stream directives when policy disables them", () => {
      const policy = resolveModelOverridePolicy({
        enabled: true,
        allowInstructions: false,
        allowStream: false,
      });
      const input = "Hello [[tts:instructions=calm stream=on]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.openai?.instructions).toBeUndefined();
      expect(result.overrides.openai?.stream).toBeUndefined();
    });

    it("blocks OpenAI responseFormat/speed/streamFormat directives when policy disables them", () => {
      const policy = resolveModelOverridePolicy({
        enabled: true,
        allowResponseFormat: false,
        allowSpeed: false,
        allowStreamFormat: false,
      });
      const input = "Hello [[tts:responseFormat=wav openai_speed=1.75 streamFormat=audio]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.openai?.responseFormat).toBeUndefined();
      expect(result.overrides.openai?.speed).toBeUndefined();
      expect(result.overrides.openai?.streamFormat).toBeUndefined();
    });

    it("accepts edge as provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.provider).toBe("edge");
    });

    it("rejects provider override by default while keeping voice overrides enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=edge voice=alloy]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.overrides.provider).toBeUndefined();
      expect(result.overrides.openai?.voice).toBe("alloy");
    });

    it("keeps text intact when overrides are disabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: false });
      const input = "Hello [[tts:voice=alloy]] world";
      const result = parseTtsDirectives(input, policy, {});

      expect(result.cleanedText).toBe(input);
      expect(result.overrides.provider).toBeUndefined();
    });
  });

  describe("openaiTTS", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends explicit optional OpenAI fields in the first request", async () => {
      const fetchMock = vi
        .fn(async () => ({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        }))
        .mockName("fetch");
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "k",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        instructions: "calm",
        stream: true,
        responseFormat: "mp3",
        speed: 1.5,
        streamFormat: "audio",
        timeoutMs: 10_000,
      });

      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBe("calm");
      expect(body.stream).toBe(true);
      expect(body.response_format).toBe("mp3");
      expect(body.speed).toBe(1.5);
      expect(body.stream_format).toBe("audio");
    });

    it("falls back to non-stream request when stream mode fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "k",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        stream: true,
        responseFormat: "mp3",
        timeoutMs: 10_000,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.stream).toBe(true);
      expect(secondBody.stream).toBeUndefined();
    });

    it("falls back to non-stream request when stream request throws", async () => {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(abortErr)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "k",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        stream: true,
        responseFormat: "mp3",
        timeoutMs: 10_000,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.stream).toBe(true);
      expect(secondBody.stream).toBeUndefined();

      const secondInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[1]?.[1] as RequestInit | undefined;
      expect(secondInit?.signal?.aborted).toBe(false);
    });

    it("retries once without instructions when upstream rejects instructions", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => '{"error":{"message":"Unsupported parameter: instructions"}}',
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "k",
        baseUrl: "http://localhost:8880/v1",
        model: "custom-model",
        voice: "custom-voice",
        instructions: "calm",
        responseFormat: "mp3",
        timeoutMs: 10_000,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.instructions).toBe("calm");
      expect(secondBody.instructions).toBeUndefined();
    });

    it("does not retry endlessly after one unsupported-instructions retry", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => '{"error":{"message":"Unsupported parameter: instructions"}}',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => '{"error":{"message":"Unsupported parameter: instructions"}}',
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          baseUrl: "http://localhost:8880/v1",
          model: "custom-model",
          voice: "custom-voice",
          instructions: "calm",
          responseFormat: "mp3",
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error (400)");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not drop explicit instructions on unsupported-parameter errors", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Unsupported parameter: instructions"}}',
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          baseUrl: "http://localhost:8880/v1",
          model: "custom-model",
          voice: "custom-voice",
          instructions: "calm",
          instructionsExplicit: true,
          responseFormat: "mp3",
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error (400)");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBe("calm");
    });

    it("retries when upstream returns generic extra-input validation errors", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => '{"error":{"message":"Extra inputs are not permitted"}}',
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1),
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await openaiTTS({
        text: "hello",
        apiKey: "k",
        baseUrl: "http://localhost:8880/v1",
        model: "custom-model",
        voice: "custom-voice",
        instructions: "calm",
        responseFormat: "mp3",
        timeoutMs: 10_000,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.instructions).toBe("calm");
      expect(secondBody.instructions).toBeUndefined();
    });

    it("does not retry on unsupported non-instruction optional fields", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Unsupported parameter: response_format"}}',
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          baseUrl: "http://localhost:8880/v1",
          model: "custom-model",
          voice: "custom-voice",
          responseFormat: "mp3",
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("OpenAI TTS API error (400)");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects unsupported sse stream format", async () => {
      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          stream: true,
          streamFormat: "sse",
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("streamFormat=sse");
    });

    it("fails fast when upstream returns a mismatched audio format", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "audio/flac" },
        arrayBuffer: async () => new ArrayBuffer(4),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("returned flac but mp3 was requested");
    });

    it("recognizes AAC ADTS profile variants when inferring returned format", async () => {
      const adts = new Uint8Array([0xff, 0xf0, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => adts.buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "aac",
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ outputFormat: "aac" });
    });

    it("classifies raw MP3 frame headers as mp3 (not aac)", async () => {
      const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => mp3Frame.buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        openaiTTS({
          text: "hello",
          apiKey: "k",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ outputFormat: "mp3" });
    });

    it("keeps strict validation when explicit baseUrl is default OpenAI endpoint", async () => {
      await withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" }, async () => {
        await expect(
          openaiTTS({
            text: "hello",
            apiKey: "k",
            baseUrl: "https://api.openai.com/v1",
            model: "custom-model",
            voice: "custom-voice",
            responseFormat: "mp3",
            timeoutMs: 10_000,
          }),
        ).rejects.toThrow("Invalid model: custom-model");
      });
    });

    it("relaxes model/voice validation on explicit custom OpenAI-compatible baseUrl", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnv({ OPENAI_TTS_BASE_URL: undefined }, async () => {
        await openaiTTS({
          text: "hello",
          apiKey: "k",
          baseUrl: "http://localhost:8880/v1",
          model: "custom-model",
          voice: "custom-voice",
          responseFormat: "mp3",
          timeoutMs: 10_000,
        });
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8880/v1/audio/speech");
    });
  });

  describe("openaiTTSReadable", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    it("keeps timeout active after headers until stream lifecycle completes", async () => {
      vi.useFakeTimers();
      let aborted = false;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
        },
      });

      const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          controllerRef?.error(new Error("aborted"));
        });
        return {
          ok: true,
          headers: { get: () => "audio/mpeg" },
          body,
        };
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await openaiTTSReadable({
        text: "hello",
        apiKey: "k",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "mp3",
        timeoutMs: 25,
      });

      expect(result.progressive).toBe(true);
      expect(aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(30);
      expect(aborted).toBe(true);
    });
  });

  describe("streaming plumbing", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const openaiCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          provider: "openai",
          openai: {
            apiKey: "test-key",
            model: "gpt-4o-mini-tts",
            voice: "alloy",
          },
        },
      },
    };

    it("streams successfully for a stream-capable provider", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await textToSpeechStream({
        text: "hello",
        cfg: openaiCfg,
        stream: { enabled: true },
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe("openai");
      expect(result.progressive).toBe(true);
      expect(result.audioStream).toBeDefined();

      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.stream).toBe(true);
    });

    it("uses configured OpenAI stream intent when stream.enabled is omitted", async () => {
      const cfg: OpenClawConfig = {
        ...openaiCfg,
        messages: {
          tts: {
            ...openaiCfg.messages?.tts,
            openai: {
              ...openaiCfg.messages?.tts?.openai,
              stream: true,
            },
          },
        },
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await textToSpeechWithFallback({
        text: "hello",
        cfg,
      });

      expect(result.success).toBe(true);
      expect(result.delivery).toBe("stream");
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.stream).toBe(true);
    });

    it("keeps buffered path when stream is disabled even if streamFormat is sse", async () => {
      const cfg: OpenClawConfig = {
        ...openaiCfg,
        messages: {
          tts: {
            ...openaiCfg.messages?.tts,
            openai: {
              ...openaiCfg.messages?.tts?.openai,
              stream: false,
              streamFormat: "sse",
            },
          },
        },
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await textToSpeechWithFallback({
        text: "hello",
        cfg,
      });

      expect(result.success).toBe(true);
      expect(result.delivery).toBe("buffered");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.stream).toBeUndefined();
    });

    it("falls back to buffered output when stream attempt times out", async () => {
      const timeoutErr = new Error("aborted");
      timeoutErr.name = "AbortError";
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(timeoutErr));
          });
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await textToSpeechWithFallback({
        text: "hello",
        cfg: openaiCfg,
        overrides: { openai: { stream: true } },
        stream: { enabled: true, timeoutMs: 1, fallbackToBuffered: true },
      });

      expect(result.success).toBe(true);
      expect(result.delivery).toBe("buffered");
      if (!result.success) {
        throw new Error("Expected buffered fallback success");
      }
      expect(result.provider).toBe("openai");
      expect(result.audioPath?.endsWith(".mp3")).toBe(true);
      expect(result.fallbackFromError).toContain("request timed out");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.stream).toBe(true);
      expect(secondBody.stream).toBeUndefined();
    });

    it("returns unsupported-provider error when stream fallback is disabled", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "edge",
          },
        },
      };

      const result = await textToSpeechWithFallback({
        text: "hello",
        cfg,
        stream: { enabled: true, fallbackToBuffered: false },
      });

      expect(result.success).toBe(false);
      expect(result.delivery).toBe("stream");
      expect(result.error).toContain("streaming unsupported for provider edge");
    });
  });

  describe("textToSpeech OpenAI integration", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("keeps buffered mp3 output as default behavior", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
            },
          },
        },
      };

      const result = await tts.textToSpeech({
        text: "hello",
        cfg,
      });

      expect(result.success).toBe(true);
      expect(result.outputFormat).toBe("mp3");
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBeUndefined();
      expect(body.stream).toBeUndefined();
      expect(body.stream_format).toBeUndefined();
      expect(body.response_format).toBeUndefined();
      expect(body.speed).toBeUndefined();
    });

    it("preserves voice-bubble response_format defaults when no explicit responseFormat is set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
            },
          },
        },
      };

      const result = await tts.textToSpeech({
        text: "hello",
        cfg,
        channel: "telegram",
      });

      expect(result.success).toBe(true);
      expect(result.outputFormat).toBe("opus");
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.response_format).toBe("opus");
    });

    it("omits implicit optional OpenAI fields for model-only tts-1 overrides", async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const rawBody = init?.body;
        const body =
          typeof rawBody === "string" && rawBody.trim()
            ? (JSON.parse(rawBody) as Record<string, unknown>)
            : {};
        if (
          "instructions" in body ||
          "stream" in body ||
          "stream_format" in body ||
          "response_format" in body ||
          "speed" in body
        ) {
          return {
            ok: false,
            status: 400,
            text: async () => '{"error":{"message":"Unsupported optional field"}}',
          };
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        };
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
            },
          },
        },
      };

      const result = await tts.textToSpeech({
        text: "hello",
        cfg,
        overrides: { openai: { model: "tts-1" } },
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.model).toBe("tts-1");
      expect(body.input).toBe("hello");
      expect(body.voice).toBe("alloy");
      expect(body.instructions).toBeUndefined();
      expect(body.stream).toBeUndefined();
      expect(body.stream_format).toBeUndefined();
      expect(body.response_format).toBeUndefined();
      expect(body.speed).toBeUndefined();
    });

    it("passes explicit optional OpenAI fields from request overrides", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
            },
          },
        },
      };

      const result = await tts.textToSpeech({
        text: "hello",
        cfg,
        overrides: {
          openai: {
            instructions: "calm",
            stream: true,
            streamFormat: "audio",
            responseFormat: "wav",
            speed: 1.25,
          },
        },
      });

      expect(result.success).toBe(true);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBe("calm");
      expect(body.stream).toBe(true);
      expect(body.stream_format).toBe("audio");
      expect(body.response_format).toBe("wav");
      expect(body.speed).toBe(1.25);
    });

    it("uses configured OpenAI baseUrl when provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              baseUrl: "http://localhost:8880/v1",
              model: "custom-model",
              voice: "custom-voice",
              stream: true,
            },
          },
        },
      };

      const result = await tts.textToSpeech({ text: "hello", cfg });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8880/v1/audio/speech");
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBeUndefined();
      expect(body.stream).toBe(true);
    });

    it("preserves configured global instructions on custom OpenAI-compatible baseUrl", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              baseUrl: "http://localhost:8880/v1",
              model: "custom-model",
              voice: "custom-voice",
              instructions: "calm and warm",
            },
          },
        },
      };

      const result = await tts.textToSpeech({ text: "hello", cfg });

      expect(result.success).toBe(true);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBe("calm and warm");
    });

    it("does not inherit configured stream when model-only override changes to non-streaming model", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
              stream: true,
            },
          },
        },
      };

      const result = await tts.textToSpeechWithFallback({
        text: "hello",
        cfg,
        overrides: { openai: { model: "tts-1" } },
      });

      expect(result.success).toBe(true);
      expect(result.delivery).toBe("buffered");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.model).toBe("tts-1");
      expect(body.stream).toBeUndefined();
    });

    it("omits global instructions automatically for tts-1", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "tts-1",
              voice: "alloy",
              instructions: "calm",
            },
          },
        },
      };

      const result = await tts.textToSpeech({ text: "hello", cfg });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBeUndefined();
    });

    it("passes explicit directive instructions for compatible models", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
            },
          },
        },
      };

      const result = await tts.textToSpeech({
        text: "hello",
        cfg,
        overrides: { openai: { instructions: "calm and warm" } },
      });

      expect(result.success).toBe(true);
      const body = getFetchRequestBody(fetchMock as unknown as { mock: { calls: unknown[][] } }, 0);
      expect(body.instructions).toBe("calm and warm");
    });

    it("retries once without instructions when upstream rejects instructions", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: { message: "Unsupported parameter: 'instructions'" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            edge: { enabled: false },
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
              instructions: "calm",
            },
          },
        },
      };

      const result = await tts.textToSpeech({ text: "hello", cfg });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        0,
      );
      const secondBody = getFetchRequestBody(
        fetchMock as unknown as { mock: { calls: unknown[][] } },
        1,
      );
      expect(firstBody.instructions).toBe("calm");
      expect(secondBody.instructions).toBeUndefined();
    });

    it("does not loop retries when instructions remain unsupported", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: { message: "Unsupported parameter: instructions" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: { message: "Unsupported parameter: instructions" } }),
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: {
          tts: {
            provider: "openai",
            edge: { enabled: false },
            openai: {
              apiKey: "test-key",
              model: "gpt-4o-mini-tts",
              voice: "alloy",
              instructions: "calm",
            },
          },
        },
      };

      const result = await tts.textToSpeech({ text: "hello", cfg });

      expect(result.success).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
});
