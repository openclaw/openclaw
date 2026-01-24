import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { _test } from "./tts.js";

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  summarizeText,
  resolveOutputFormat,
} = _test;

describe("tts", () => {
  describe("isValidVoiceId", () => {
    it("accepts valid ElevenLabs voice IDs", () => {
      expect(isValidVoiceId("pMsXgVXv3BLzUgSXRplE")).toBe(true);
      expect(isValidVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(true);
      expect(isValidVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(true);
    });

    it("accepts voice IDs of varying valid lengths", () => {
      expect(isValidVoiceId("a1b2c3d4e5")).toBe(true);
      expect(isValidVoiceId("a".repeat(40))).toBe(true);
    });

    it("rejects too short voice IDs", () => {
      expect(isValidVoiceId("")).toBe(false);
      expect(isValidVoiceId("abc")).toBe(false);
      expect(isValidVoiceId("123456789")).toBe(false);
    });

    it("rejects too long voice IDs", () => {
      expect(isValidVoiceId("a".repeat(41))).toBe(false);
      expect(isValidVoiceId("a".repeat(100))).toBe(false);
    });

    it("rejects voice IDs with invalid characters", () => {
      expect(isValidVoiceId("pMsXgVXv3BLz-gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz_gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz gSXRplE")).toBe(false);
      expect(isValidVoiceId("../../../etc/passwd")).toBe(false);
      expect(isValidVoiceId("voice?param=value")).toBe(false);
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
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
    it("accepts gpt-4o-mini-tts model", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts")).toBe(true);
    });

    it("rejects other models", () => {
      expect(isValidOpenAIModel("tts-1")).toBe(false);
      expect(isValidOpenAIModel("tts-1-hd")).toBe(false);
      expect(isValidOpenAIModel("invalid")).toBe(false);
      expect(isValidOpenAIModel("")).toBe(false);
      expect(isValidOpenAIModel("gpt-4")).toBe(false);
    });
  });

  describe("OPENAI_TTS_MODELS", () => {
    it("contains only gpt-4o-mini-tts", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toHaveLength(1);
    });

    it("is a non-empty array", () => {
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
    });
  });

  describe("resolveOutputFormat", () => {
    it("uses Opus for Telegram", () => {
      const output = resolveOutputFormat("telegram");
      expect(output.openai).toBe("opus");
      expect(output.elevenlabs).toBe("opus_48000_64");
      expect(output.extension).toBe(".opus");
      expect(output.voiceCompatible).toBe(true);
    });

    it("uses MP3 for other channels", () => {
      const output = resolveOutputFormat("discord");
      expect(output.openai).toBe("mp3");
      expect(output.elevenlabs).toBe("mp3_44100_128");
      expect(output.extension).toBe(".mp3");
      expect(output.voiceCompatible).toBe(false);
    });
  });

  describe("summarizeText", () => {
    const mockApiKey = "test-api-key";
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: mockSummary } }],
          }),
      });

      const longText = "A".repeat(2000);
      const result = await summarizeText(longText, 1500, mockApiKey, 30_000);

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("calls OpenAI API with correct parameters", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Summary" } }],
          }),
      });

      await summarizeText("Long text to summarize", 500, mockApiKey, 30_000);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
            "Content-Type": "application/json",
          },
        }),
      );

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0.3);
      expect(body.max_tokens).toBe(250);
    });

    it("rejects targetLength below minimum (100)", async () => {
      await expect(summarizeText("text", 99, mockApiKey, 30_000)).rejects.toThrow(
        "Invalid targetLength: 99",
      );
    });

    it("rejects targetLength above maximum (10000)", async () => {
      await expect(summarizeText("text", 10001, mockApiKey, 30_000)).rejects.toThrow(
        "Invalid targetLength: 10001",
      );
    });

    it("accepts targetLength at boundaries", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Summary" } }],
          }),
      });

      await expect(summarizeText("text", 100, mockApiKey, 30_000)).resolves.toBeDefined();
      await expect(summarizeText("text", 10000, mockApiKey, 30_000)).resolves.toBeDefined();
    });

    it("throws error when API returns non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(summarizeText("text", 500, mockApiKey, 30_000)).rejects.toThrow(
        "Summarization service unavailable",
      );
    });

    it("throws error when no summary is returned", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [],
          }),
      });

      await expect(summarizeText("text", 500, mockApiKey, 30_000)).rejects.toThrow(
        "No summary returned",
      );
    });

    it("throws error when summary content is empty", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "   " } }],
          }),
      });

      await expect(summarizeText("text", 500, mockApiKey, 30_000)).rejects.toThrow(
        "No summary returned",
      );
    });
  });
});
