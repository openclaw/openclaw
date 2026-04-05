import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, validateConfigObject } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("legacy provider-shaped config snapshots", () => {
  it("accepts a string map of voice aliases while still flagging legacy talk config", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        talk: {
          voiceAliases: {
            Clawd: "VoiceAlias1234567890",
            Roger: "CwhRBWXzGAHq8TQ4Fs17",
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "talk")).toBe(true);
      expect(snap.sourceConfig.talk?.providers?.elevenlabs?.voiceAliases).toEqual({
        Clawd: "VoiceAlias1234567890",
        Roger: "CwhRBWXzGAHq8TQ4Fs17",
      });
    });
  });

  it("rejects non-string voice alias values", () => {
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("detects legacy messages.tts provider keys and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
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

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "messages.tts")).toBe(true);
      expect(snap.sourceConfig.messages?.tts).toEqual({
        provider: "elevenlabs",
        elevenlabs: {
          apiKey: "test-key",
          voiceId: "voice-1",
        },
      });
    });
  });

  it("reports legacy talk flat fields without auto-migrating them at config load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        talk: {
          voiceId: "voice-1",
          modelId: "eleven_v3",
          apiKey: "test-key",
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "talk")).toBe(true);
      expect(snap.sourceConfig.talk).toEqual({
        voiceId: "voice-1",
        modelId: "eleven_v3",
        apiKey: "test-key",
      });
    });
  });

  it("detects legacy plugins.entries.*.config.tts provider keys", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
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

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "plugins.entries")).toBe(true);
      const voiceCallTts = (
        snap.sourceConfig.plugins?.entries as
          | Record<
              string,
              {
                config?: {
                  tts?: {
                    providers?: Record<string, unknown>;
                    openai?: unknown;
                  };
                };
              }
            >
          | undefined
      )?.["voice-call"]?.config?.tts;
      expect(voiceCallTts).toEqual({
        provider: "openai",
        openai: {
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
      });
    });
  });

  it("detects legacy discord voice tts provider keys and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          discord: {
            voice: {
              tts: {
                provider: "elevenlabs",
                elevenlabs: {
                  voiceId: "voice-1",
                },
              },
            },
            accounts: {
              main: {
                voice: {
                  tts: {
                    edge: {
                      voice: "en-US-AvaNeural",
                    },
                  },
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.voice.tts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.sourceConfig.channels?.discord?.voice?.tts).toEqual({
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "voice-1",
        },
      });
      expect(snap.sourceConfig.channels?.discord?.accounts?.main?.voice?.tts).toEqual({
        edge: {
          voice: "en-US-AvaNeural",
        },
      });
    });
  });
});
