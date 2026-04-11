import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  const { next, changes } = applyLegacyDoctorMigrations(raw);
  return { config: next as OpenClawConfig | null, changes };
}

describe("legacy migrate provider-shaped config", () => {
  it("moves messages.tts.<provider> keys into messages.tts.providers", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            apiKey: "test-key",
            voiceId: "voice-1",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved messages.tts.elevenlabs → messages.tts.providers.elevenlabs.",
    );
    expect(res.config?.messages?.tts).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "test-key",
          voiceId: "voice-1",
        },
      },
    });
  });

  it("moves channels.discord.accounts.<id>.voice.tts.edge into providers.microsoft", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            main: {
              voice: {
                tts: {
                  edge: {
                    voice: "en-US-JennyNeural",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.accounts.main.voice.tts.edge → channels.discord.accounts.main.voice.tts.providers.microsoft.",
    );
    const mainTts = (
      res.config?.channels?.discord?.accounts as
        | Record<string, { voice?: { tts?: Record<string, unknown> } }>
        | undefined
    )?.main?.voice?.tts;
    expect(mainTts?.providers).toEqual({
      microsoft: {
        voice: "en-US-JennyNeural",
      },
    });
    expect(mainTts?.edge).toBeUndefined();
  });

  it("moves plugins.entries.voice-call.config.tts.<provider> keys into providers", () => {
    const res = migrateLegacyConfig({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              tts: {
                provider: "openai",
                openai: {
                  model: "gpt-4o-mini-tts",
                  voice: "alloy",
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved plugins.entries.voice-call.config.tts.openai → plugins.entries.voice-call.config.tts.providers.openai.",
    );
    const voiceCallTts = (
      res.config?.plugins?.entries as
        | Record<string, { config?: { tts?: Record<string, unknown> } }>
        | undefined
    )?.["voice-call"]?.config?.tts;
    expect(voiceCallTts).toEqual({
      provider: "openai",
      providers: {
        openai: {
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
      },
    });
  });

  it("does not migrate legacy tts provider keys for unknown plugin ids", () => {
    const res = migrateLegacyConfig({
      plugins: {
        entries: {
          "third-party-plugin": {
            config: {
              tts: {
                provider: "openai",
                openai: {
                  model: "custom-tts",
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not migrate extension-owned talk legacy fields during config-load migration", () => {
    const res = migrateLegacyConfig({
      talk: {
        voiceId: "voice-1",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        apiKey: "test-key",
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
  });
});
