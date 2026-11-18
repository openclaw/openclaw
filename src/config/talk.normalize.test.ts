import { describe, expect, it } from "vitest";
import { TALK_TEST_PROVIDER_ID } from "../test-utils/talk-test-provider.js";
import { buildTalkConfigResponse, normalizeTalkSection } from "./talk.js";

describe("talk normalization", () => {
  it("preserves the explicit ambient Talk agent", () => {
    expect(normalizeTalkSection({ agentId: " ops " })).toEqual({ agentId: "ops" });
    expect(buildTalkConfigResponse({ agentId: "ops" })).toEqual({ agentId: "ops" });
  });

  it("uses new provider/providers shape directly when present", () => {
    const config = {
      provider: "acme",
      providers: { acme: { voiceId: "acme-voice", custom: true } },
      realtime: {
        provider: "openai",
        providers: { openai: { model: "gpt-realtime" } },
        model: "gpt-realtime",
        speakerVoice: "alloy",
        speakerVoiceId: "voice-123",
        mode: "realtime",
        transport: "webrtc",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: " low ",
        brain: "agent-consult",
        consultRouting: "force-agent-consult",
      },
      interruptOnSpeech: true,
    } as const;
    expect(normalizeTalkSection(structuredClone(config))).toEqual({
      ...config,
      realtime: { ...config.realtime, reasoningEffort: "low" },
    });
  });

  it("drops invalid realtime voice detection defaults", () => {
    const normalized = normalizeTalkSection({
      realtime: {
        vadThreshold: 1.5,
        silenceDurationMs: 0,
        prefixPaddingMs: -1,
        reasoningEffort: "   ",
      },
    } as never);

    expect(normalized).toBeUndefined();
  });

  it("builds a canonical resolved talk payload for clients", () => {
    const config = {
      provider: "acme",
      providers: { acme: { voiceId: "acme-voice", modelId: "acme-model" } },
      speechLocale: "ru-RU",
      interruptOnSpeech: true,
    };
    expect(buildTalkConfigResponse(structuredClone(config))).toEqual({
      ...config,
      resolved: { provider: "acme", config: config.providers.acme },
    });
  });

  it("preserves normalized realtime instructions in talk.config payloads", () => {
    const payload = buildTalkConfigResponse(
      normalizeTalkSection({
        realtime: {
          provider: "openai",
          providers: { openai: { model: "gpt-realtime", speakerVoice: "alloy" } },
          instructions: " Speak with crisp diction. ",
        },
      }),
    );

    expect(payload?.realtime?.provider).toBe("openai");
    expect(payload?.realtime?.instructions).toBe("Speak with crisp diction.");
  });

  it("does not resolve inherited Object.prototype provider key constructor", () => {
    const payload = buildTalkConfigResponse({
      provider: "constructor",
      providers: { elevenlabs: { voiceId: "voice-123" } },
    });
    expect(payload?.resolved).toBeUndefined();
    expect(payload?.provider).toBeUndefined();
  });

  it("preserves SecretRef apiKey values during normalization", () => {
    const config = {
      provider: TALK_TEST_PROVIDER_ID,
      providers: {
        [TALK_TEST_PROVIDER_ID]: {
          apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
        },
      },
    } as const;
    expect(normalizeTalkSection(structuredClone(config))).toEqual(config);
  });
});
