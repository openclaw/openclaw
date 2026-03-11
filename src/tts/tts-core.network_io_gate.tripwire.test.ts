/**
 * Tripwire tests for TTS NETWORK_IO gating.
 * Validates that ElevenLabs and OpenAI TTS endpoints call applyNetworkIOGateAndFetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { elevenLabsTTS, openaiTTS } from "./tts-core.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import * as networkIOGating from "../clarityburst/network-io-gating.js";

describe("TTS NETWORK_IO Gating", () => {
  let gateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    gateSpy = vi.spyOn(networkIOGating, "applyNetworkIOGateAndFetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ElevenLabs TTS gating (src/tts/tts-core.ts:557)", () => {
    it("should call applyNetworkIOGateAndFetch", async () => {
      const mockBuffer = Buffer.from("audio-data");
      gateSpy.mockResolvedValueOnce(
        new Response(mockBuffer, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );

      try {
        await elevenLabsTTS({
          text: "Hello world",
          apiKey: "test-key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          modelId: "eleven_monolingual_v1",
          outputFormat: "mp3_22050_32",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0,
            useSpeakerBoost: false,
            speed: 1,
          },
          timeoutMs: 10000,
        });
      } catch {
        // Expected if buffer handling fails
      }

      expect(gateSpy).toHaveBeenCalled();
      const callUrl = gateSpy.mock.calls[0][0];
      expect(callUrl).toContain("api.elevenlabs.io");
    });

    it("should block synthesis when gate abstains (ABSTAIN_CONFIRM)", async () => {
      gateSpy.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
          reason: "Policy check required",
          contractId: "NETWORK_POST_TTS",
          instructions: "Confirmation required for TTS synthesis",
        }),
      );

      await expect(
        elevenLabsTTS({
          text: "Hello",
          apiKey: "test-key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          modelId: "eleven_monolingual_v1",
          outputFormat: "mp3_22050_32",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0,
            useSpeakerBoost: false,
            speed: 1,
          },
          timeoutMs: 10000,
        }),
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(gateSpy).toHaveBeenCalled();
    });
  });

  describe("OpenAI TTS gating (src/tts/tts-core.ts:612)", () => {
    it("should call applyNetworkIOGateAndFetch", async () => {
      const mockBuffer = Buffer.from("audio-data");
      gateSpy.mockResolvedValueOnce(
        new Response(mockBuffer, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );

      try {
        await openaiTTS({
          text: "Hello world",
          apiKey: "sk-test",
          model: "tts-1",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 10000,
        });
      } catch {
        // Expected if buffer handling fails
      }

      expect(gateSpy).toHaveBeenCalled();
      const callUrl = gateSpy.mock.calls[0][0];
      expect(callUrl).toContain("api.openai.com");
    });

    it("should block synthesis when gate abstains (ABSTAIN_CONFIRM)", async () => {
      gateSpy.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
          reason: "Policy check required",
          contractId: "NETWORK_POST_TTS",
          instructions: "Confirmation required for TTS synthesis",
        }),
      );

      await expect(
        openaiTTS({
          text: "Hello",
          apiKey: "sk-test",
          model: "tts-1",
          voice: "alloy",
          responseFormat: "mp3",
          timeoutMs: 10000,
        }),
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(gateSpy).toHaveBeenCalled();
    });
  });

  describe("TTS inference coverage", () => {
    it("documents ElevenLabs and OpenAI TTS as Class 1 (INFERENCE) endpoints", () => {
      // Both TTS functions exist and are exported
      expect(typeof elevenLabsTTS).toBe("function");
      expect(typeof openaiTTS).toBe("function");

      // Both are now gated inference endpoints in NETWORK_IO coverage matrix
    });
  });
});
