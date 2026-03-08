import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
  EndBehaviorType: { AfterSilence: "AfterSilence" },
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Destroyed: "destroyed",
    Signalling: "signalling",
    Connecting: "connecting",
  },
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  entersState: vi.fn(),
  joinVoiceChannel: vi.fn(),
}));

import { resolveVoiceTtsConfig } from "./manager.js";

describe("resolveVoiceTtsConfig", () => {
  it("preserves mixed-case agent TTS overrides when voice-channel TTS override is enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-4o-mini" } },
        list: [
          {
            id: "VoiceAgent",
            tts: {
              provider: "elevenlabs",
              elevenlabs: {
                voiceId: "A1B2C3D4E5F6G7H8I9J0",
              },
            },
          },
        ],
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "J0I9H8G7F6E5D4C3B2A1",
          },
        },
      },
    };

    const { resolved } = resolveVoiceTtsConfig({
      cfg,
      agentId: "voiceagent",
      override: {
        elevenlabs: {
          modelId: "eleven_flash_v2_5",
        },
      },
    });

    expect(resolved.elevenlabs.voiceId).toBe("A1B2C3D4E5F6G7H8I9J0");
    expect(resolved.elevenlabs.modelId).toBe("eleven_flash_v2_5");
  });
});
