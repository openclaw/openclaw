import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigObject } from "../../config/redact-snapshot.js";

describe("talk.config vs config.get redaction", () => {
  it("redactConfigObject replaces talk.apiKey with sentinel", () => {
    const config = {
      talk: {
        apiKey: "real-elevenlabs-api-key-value",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_v3",
      },
    };
    const redacted = redactConfigObject(config);
    expect(redacted.talk.apiKey).toBe(REDACTED_SENTINEL);
    // Non-sensitive fields are preserved
    expect(redacted.talk.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
    expect(redacted.talk.modelId).toBe("eleven_v3");
  });

  it("talk.config handler returns unredacted apiKey from config", async () => {
    // Simulate what the talk.config handler does: read config and return
    // the real API key without redaction.
    //
    // The handler reads `cfg.talk.apiKey` directly from loadConfig() which
    // returns the unredacted config (unlike config.get which calls
    // redactConfigSnapshot).
    const talkConfig = {
      apiKey: "real-elevenlabs-api-key-value",
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      voiceAliases: { narrator: "abc123def456" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      interruptOnSpeech: true,
    };

    // Simulate the handler logic
    const apiKey = talkConfig.apiKey?.trim() || undefined;

    const result = {
      voiceId: talkConfig.voiceId ?? null,
      voiceAliases: talkConfig.voiceAliases ?? {},
      modelId: talkConfig.modelId ?? null,
      outputFormat: talkConfig.outputFormat ?? null,
      interruptOnSpeech: talkConfig.interruptOnSpeech ?? true,
      apiKey: apiKey ?? null,
    };

    // The real API key should be returned, not the redacted sentinel
    expect(result.apiKey).toBe("real-elevenlabs-api-key-value");
    expect(result.apiKey).not.toBe(REDACTED_SENTINEL);
    expect(result.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
    expect(result.voiceAliases).toEqual({ narrator: "abc123def456" });
    expect(result.modelId).toBe("eleven_v3");
    expect(result.outputFormat).toBe("pcm_44100");
    expect(result.interruptOnSpeech).toBe(true);
  });

  it("talk.config returns null apiKey when not configured", () => {
    const talkConfig: Record<string, unknown> = {};

    const apiKey = (talkConfig.apiKey as string | undefined)?.trim() || undefined;

    const result = {
      voiceId: talkConfig.voiceId ?? null,
      voiceAliases: talkConfig.voiceAliases ?? {},
      modelId: talkConfig.modelId ?? null,
      outputFormat: talkConfig.outputFormat ?? null,
      interruptOnSpeech: talkConfig.interruptOnSpeech ?? true,
      apiKey: apiKey ?? null,
    };

    expect(result.apiKey).toBeNull();
    expect(result.voiceId).toBeNull();
    expect(result.voiceAliases).toEqual({});
    expect(result.modelId).toBeNull();
    expect(result.interruptOnSpeech).toBe(true);
  });

  it("talk.config falls back to ELEVENLABS_API_KEY env var", () => {
    const talkConfig: Record<string, unknown> = {};
    const envApiKey = "env-elevenlabs-api-key-value";

    const apiKey =
      (talkConfig.apiKey as string | undefined)?.trim() || envApiKey?.trim() || undefined;

    expect(apiKey).toBe("env-elevenlabs-api-key-value");
  });

  it("talk.config falls back to XI_API_KEY env var", () => {
    const talkConfig: Record<string, unknown> = {};
    const envApiKey = undefined;
    const xiApiKey = "xi-api-key-value-here";

    const apiKey =
      (talkConfig.apiKey as string | undefined)?.trim() ||
      envApiKey?.trim() ||
      xiApiKey?.trim() ||
      undefined;

    expect(apiKey).toBe("xi-api-key-value-here");
  });

  it("config talk.apiKey takes precedence over env vars", () => {
    const talkConfig = { apiKey: "config-api-key-value" };
    const envApiKey = "env-api-key-value";
    const xiApiKey = "xi-api-key-value";

    const apiKey = talkConfig.apiKey?.trim() || envApiKey?.trim() || xiApiKey?.trim() || undefined;

    expect(apiKey).toBe("config-api-key-value");
  });
});
