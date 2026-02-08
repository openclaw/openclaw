import { describe, expect, it } from "vitest";
/**
 * VULN-155: TTS API Keys must not appear in error logs
 *
 * This test verifies that API keys are sanitized from TTS error messages
 * to prevent credential leakage in logs.
 *
 * CWE-532: Insertion of Sensitive Information into Log File
 */
// Import the internal test exports
import { _test } from "./tts.js";

const { sanitizeTtsError } = _test;

describe("VULN-155: TTS error sanitization", () => {
  describe("sanitizeTtsError", () => {
    it("redacts ElevenLabs API keys (sk_ format)", () => {
      const error = new Error('Request failed with headers: {"xi-api-key": "sk_abc123xyz789"}');
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).not.toContain("sk_abc123xyz789");
      expect(sanitized).toContain("***REDACTED***");
    });

    it("redacts OpenAI API keys (sk- format)", () => {
      const error = new Error("Authorization: Bearer sk-abc123xyz789defghijklmnopqrstuvwxyz");
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).not.toContain("sk-abc123xyz789defghijklmnopqrstuvwxyz");
      expect(sanitized).toContain("***REDACTED***");
    });

    it("redacts xi-api-key header values", () => {
      const error = new Error('headers: { "xi-api-key": "my_secret_elevenlabs_key_12345" }');
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).not.toContain("my_secret_elevenlabs_key_12345");
    });

    it("redacts Bearer token values", () => {
      const error = new Error("Authorization header was: Bearer some_oauth_token_value_here");
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).not.toContain("some_oauth_token_value_here");
    });

    it("preserves safe error messages", () => {
      const error = new Error("ElevenLabs API error (401)");
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).toBe("ElevenLabs API error (401)");
    });

    it("handles non-Error objects", () => {
      const sanitized = sanitizeTtsError("string error message");
      expect(sanitized).toBe("string error message");
    });

    it("handles network errors without leaking details", () => {
      const error = new Error(
        "fetch failed: ECONNREFUSED with request to https://api.elevenlabs.io",
      );
      const sanitized = sanitizeTtsError(error);
      expect(sanitized).toContain("ECONNREFUSED");
    });
  });
});
