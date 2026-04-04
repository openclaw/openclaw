import { describe, expect, test } from "vitest";
import { buildTalkConfigResponse, LEGACY_TALK_PROVIDER_ID, normalizeTalkSection } from "./talk.js";
import type { TalkConfig } from "./types.gateway.js";

describe("Talk Configuration Compatibility", () => {
  test("normalizes legacy root-level config to elevenlabs provider", () => {
    const legacyConfig = {
      voiceId: "paul-legacy-id",
      modelId: "eleven_turbo_v2",
      apiKey: "sk-legacy-key",
      silenceTimeoutMs: 2000,
      interruptOnSpeech: true,
    };

    const normalized = normalizeTalkSection(legacyConfig as TalkConfig);

    expect(normalized).toBeDefined();
    // Should have moved values into providers.elevenlabs
    expect(normalized?.providers?.[LEGACY_TALK_PROVIDER_ID]).toMatchObject({
      voiceId: "paul-legacy-id",
      modelId: "eleven_turbo_v2",
      apiKey: "sk-legacy-key",
    });

    // Root level should also still have these for backwards compatibility with older clients
    expect(normalized?.voiceId).toBe("paul-legacy-id");
    expect(normalized?.modelId).toBe("eleven_turbo_v2");
    expect(normalized?.silenceTimeoutMs).toBe(2000);
    expect(normalized?.interruptOnSpeech).toBe(true);
  });

  test("buildTalkConfigResponse includes both 'resolved' and compatibility fields", () => {
    const legacyConfig = {
      voiceId: "legacy-voice",
      modelId: "legacy-model",
      apiKey: "legacy-key",
    };

    const response = buildTalkConfigResponse(legacyConfig);

    expect(response).toBeDefined();
    // 'resolved' is what modern apps use
    expect(response?.resolved).toBeDefined();
    expect(response?.resolved?.provider).toBe(LEGACY_TALK_PROVIDER_ID);
    expect(response?.resolved?.config?.voiceId).toBe("legacy-voice");

    // Root level fields are what older apps (or apps using simple parsers) use
    expect(response?.voiceId).toBe("legacy-voice");
    expect(response?.modelId).toBe("legacy-model");
    expect(response?.apiKey).toBe("legacy-key");
  });

  test("provider-specific config overrides legacy root config in response", () => {
    const mixedConfig = {
      voiceId: "root-voice",
      provider: "mistral",
      providers: {
        mistral: {
          voiceId: "mistral-voice",
          modelId: "mistral-model",
        },
      },
    };

    const response = buildTalkConfigResponse(mixedConfig);

    expect(response?.resolved?.provider).toBe("mistral");
    expect(response?.resolved?.config?.voiceId).toBe("mistral-voice");

    // The compatibility fields should reflect the ACTIVE provider's values
    expect(response?.voiceId).toBe("mistral-voice");
    expect(response?.modelId).toBe("mistral-model");
  });
});
