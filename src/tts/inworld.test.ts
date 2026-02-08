/**
 * Unit tests for Inworld TTS Provider
 *
 * Run with: npx vitest run src/tts/inworld.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inworldTTS, INWORLD_VOICE_IDS, INWORLD_MODELS } from "./inworld";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Inworld TTS Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set default API key for tests
    process.env.INWORLD_API_KEY = "test-api-key";
  });

  afterEach(() => {
    delete process.env.INWORLD_API_KEY;
  });

  describe("Voice validation", () => {
    it("should have 65 voices available", () => {
      expect(INWORLD_VOICE_IDS.length).toBe(65);
    });

    it("should include English voices", () => {
      expect(INWORLD_VOICE_IDS).toContain("Dennis");
      expect(INWORLD_VOICE_IDS).toContain("Pixie");
      expect(INWORLD_VOICE_IDS).toContain("Theodore");
    });

    it("should include German voices", () => {
      expect(INWORLD_VOICE_IDS).toContain("Johanna");
      expect(INWORLD_VOICE_IDS).toContain("Josef");
    });

    it("should support case-insensitive voice lookup", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Hello", { inworld: { voiceId: "DENNIS" } });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"voiceId":"Dennis"'),
        }),
      );
    });

    it("should include voices from all 15 languages", () => {
      // Sample voice from each language
      const languageVoices = [
        "Dennis", // English
        "Johanna", // German
        "Jing", // Chinese
        "Erik", // Dutch
        "Alain", // French
        "Gianni", // Italian
        "Asuka", // Japanese
        "Minji", // Korean
        "Szymon", // Polish
        "Heitor", // Portuguese
        "Diego", // Spanish
        "Dmitry", // Russian
        "Manoj", // Hindi
        "Oren", // Hebrew
        "Nour", // Arabic
      ];
      languageVoices.forEach((voice) => {
        expect(INWORLD_VOICE_IDS).toContain(voice);
      });
    });
  });

  describe("Model validation", () => {
    it("should have 2 models available", () => {
      expect(INWORLD_MODELS.length).toBe(2);
    });

    it("should include standard and max models", () => {
      expect(INWORLD_MODELS).toContain("inworld-tts-1");
      expect(INWORLD_MODELS).toContain("inworld-tts-1-max");
    });
  });

  describe("API key handling", () => {
    it("should fail without API key", async () => {
      delete process.env.INWORLD_API_KEY;

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("API key not configured");
      expect(result.provider).toBe("inworld");
    });

    it("should use API key from config over env", async () => {
      const configApiKey = "config-api-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Hello", { inworld: { apiKey: configApiKey } });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${configApiKey}`,
          }),
        }),
      );
    });
  });

  describe("Successful TTS generation", () => {
    it("should return audio path on success", async () => {
      const fakeAudio = Buffer.from("fake-audio-data");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: fakeAudio.toString("base64") }),
      });

      const result = await inworldTTS("Hello world", {
        inworld: { voiceId: "Dennis" },
      });

      expect(result.success).toBe(true);
      expect(result.audioPath).toBeDefined();
      expect(result.audioPath).toMatch(/\.ogg$/); // Default opus format
      expect(result.provider).toBe("inworld");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should use correct file extension for mp3", async () => {
      const fakeAudio = Buffer.from("fake-audio-data");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: fakeAudio.toString("base64") }),
      });

      const result = await inworldTTS("Hello", {
        inworld: { outputFormat: "mp3" },
      });

      expect(result.success).toBe(true);
      expect(result.audioPath).toMatch(/\.mp3$/);
    });

    it("should send correct payload to API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Test text", {
        inworld: {
          voiceId: "Pixie",
          modelId: "inworld-tts-1-max",
          outputFormat: "wav",
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.inworld.ai/tts/v1/voice",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            text: "Test text",
            voiceId: "Pixie",
            modelId: "inworld-tts-1-max",
            outputFormat: "WAV",
          }),
        }),
      );
    });
  });

  describe("Error handling", () => {
    it("should handle 401 unauthorized", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid or expired");
    });

    it("should handle 429 rate limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded",
      });

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("rate limit");
    });

    it("should handle 402 quota exceeded", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => "Payment required",
      });

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("quota exceeded");
    });

    it("should handle empty audio response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: "" }),
      });

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no audio content");
    });

    it("should handle missing audioContent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no audio content");
    });

    it("should handle network errors", async () => {
      const networkError = Object.assign(new Error("Network error"), { code: "ENOTFOUND" });
      mockFetch.mockRejectedValueOnce(networkError);

      const result = await inworldTTS("Hello", { inworld: {} });

      expect(result.success).toBe(false);
      expect(result.error).toContain("internet connection");
    });

    it("should handle invalid model gracefully", async () => {
      const result = await inworldTTS("Hello", {
        // @ts-expect-error Testing invalid model ID
        inworld: { modelId: "invalid-model" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid model");
    });
  });

  describe("Default values", () => {
    it("should use Dennis as default voice", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Hello", { inworld: {} });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"voiceId":"Dennis"'),
        }),
      );
    });

    it("should use inworld-tts-1 as default model", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Hello", { inworld: {} });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"modelId":"inworld-tts-1"'),
        }),
      );
    });

    it("should use opus as default format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ audioContent: Buffer.from("test").toString("base64") }),
      });

      await inworldTTS("Hello", { inworld: {} });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"outputFormat":"OPUS"'),
        }),
      );
    });
  });
});
